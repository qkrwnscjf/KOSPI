// Yahoo 과거 일봉 → index_daily 행 (docs/Task_ORDER.md T-104 ③, D-67)
// 순수 함수만 둔다(테스트 대상). 받아 오기·저장은 backfill.ts의 runDailyHistoryBackfill이 한다.

import { closeTimestamp, shiftDate } from '../krx/krx-index-daily.js';
import { YAHOO_MARKET } from '../ingestion/market-hours.js';
import type { YahooSymbolKey } from '../../shared/symbols.js';

// ── 공식 종가 보정 (docs/Task_ORDER.md T-136, D-81) ──
// 1일 봉은 실시간 원본으로만 만들어진다. 스택이 장의 일부 시간만 떠 있던 날은 종가가 실제 종가와 다르다(B-49 진단).
// 장 시간이 정해진 시장의 지표는 장이 끝난 뒤 Yahoo 일봉(공식 종가)을 index_daily에 받아 두고, 그래프·리스크 계산은 그 값을 먼저 쓴다.
// 24시간 시장(환율·원자재·VIX)은 하루 종가의 기준이 소스마다 달라 지금처럼 집계를 쓴다.
export const CLOSE_FIX_DAYS = 10;
export const usesOfficialDailyClose = (key: YahooSymbolKey) => YAHOO_MARKET[key] !== 'global_24h';
// 당일 봉 확정 (T-145): 그 시장의 장이 끝나고 30분 뒤부터 받는다. 지표마다 장 하나에 한 번이고, 다음 장 뒤에 최근 10일을 다시 받아 정정도 반영한다
export const CLOSE_FIX_MARGIN_MS = 30 * 60_000;
export const shouldRefreshClose = (lastFetchedMs: number | undefined, sessionEndMs: number | null, marginMs = CLOSE_FIX_MARGIN_MS) =>
  sessionEndMs !== null && (lastFetchedMs === undefined || lastFetchedMs < sessionEndMs + marginMs);

export interface DailyBar {
  time: Date;
  price: number;
  changeRate: number;
  changePrice: number;
}

export interface DailyRow {
  time: number; // ms
  close: number;
  changeRate: number;
  changePrice: number;
}

// 서울 기준 날짜(YYYYMMDD). 한국은 서머타임이 없어 +9시간 고정
const seoulDay = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');

// - 기준 시각은 KRX 일별 값과 같은 규칙(그 거래일 15:30 KST)으로 맞춘다. 두 소스의 일별 값이 한 테이블에 같은 기준으로 쌓인다.
// - 시작한 지 24시간이 지나지 않은 봉은 아직 끝나지 않았을 수 있어(장중 값) 넣지 않는다. 시장마다 장 시간이 달라
//   "서울 기준 오늘"로 거르면 미국 장의 진행 중인 봉이 들어간다. 빠진 날은 실시간 집계가 만들거나 이음매 확인 때 다시 받는다.
// - 같은 날짜가 두 번 오면 마지막 값을 쓴다.
// - finishedBeforeMs를 주면(T-145, 장 시간이 정해진 시장) 24시간 대신 이 시각보다 앞선 봉을 끝난 봉으로 본다.
//   진행 중인 봉의 시각은 마지막 거래 시각이라, 지난 장의 마감 + 여유 시간보다 늦다.
export function toDailyRows(bars: DailyBar[], nowMs: number, finishedBeforeMs?: number): DailyRow[] {
  const byDay = new Map<string, DailyRow>();
  for (const bar of bars) {
    if (finishedBeforeMs !== undefined ? bar.time.getTime() >= finishedBeforeMs : bar.time.getTime() > nowMs - 86_400_000) continue;
    const day = seoulDay(bar.time.getTime());
    byDay.set(day, { time: closeTimestamp(day), close: bar.price, changeRate: bar.changeRate, changePrice: bar.changePrice });
  }
  return [...byDay.values()].sort((a, b) => a.time - b.time);
}

// 두 날짜(YYYYMMDD) 사이(양 끝 제외)의 평일 수
function weekdaysBetween(from: string, to: string) {
  let count = 0;
  for (let day = shiftDate(from, 1); day < to; day = shiftDate(day, 1)) {
    const weekday = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)))).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

// 집계가 시작된 뒤 이 기간까지만 이음매의 빈 날을 다시 확인한다 (공휴일 때문에 끝없이 다시 받지 않도록)
export const GAP_FILL_DAYS = 14;

// ── 빠진 날 메우기 (docs/Task_ORDER.md T-127, D-74) ──
// 스택이 꺼져 있던 날은 실시간 집계(market_1d)에 그 날짜 봉이 없다(원본이 3시간 뒤 지워져 다시 만들 수도 없음).
// 최근 GAP_LOOKBACK_DAYS일 중 집계에도 일봉(index_daily)에도 없는 평일을 찾아, 그 날짜만 Yahoo 일봉으로 index_daily에 넣는다.
// 집계는 다시 계산하지 않는다(저장 불변 조건). 공휴일은 Yahoo에도 봉이 없어 채워지지 않으므로, 같은 지표는 하루 한 번만 다시 확인한다.
export const GAP_LOOKBACK_DAYS = 30;
// 최근 이틀은 Yahoo가 일봉을 아직 확정하지 않았을 수 있고 실시간 집계도 만들어지는 중이라 보지 않는다
export const GAP_MIN_AGE_DAYS = 2;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// 집계 버킷과 일봉의 날짜(UTC 날짜 YYYY-MM-DD, 일봉 시각 15:30 KST = 06:30 UTC라 거래일과 같음)를 받아 빠진 평일을 돌려준다.
// 집계가 시작된 날(firstAggDay) 이전은 위의 이음매 규칙(needsDailyHistory)이 맡으므로 보지 않는다.
export function missingWeekdays(aggDays: Iterable<string>, dailyDays: Iterable<string>, firstAggDay: string | null, nowMs: number,
  lookbackDays = GAP_LOOKBACK_DAYS, minAgeDays = GAP_MIN_AGE_DAYS): string[] {
  if (firstAggDay === null) return [];
  const present = new Set<string>([...aggDays, ...dailyDays]);
  const todayStart = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const missing: string[] = [];
  for (let back = lookbackDays; back >= minAgeDays; back -= 1) {
    const ms = todayStart - back * 86_400_000;
    const day = isoDay(ms);
    const weekday = new Date(ms).getUTCDay();
    if (weekday === 0 || weekday === 6 || day < firstAggDay || present.has(day)) continue;
    missing.push(day);
  }
  return missing;
}

// 과거 일봉을 (다시) 받아야 하는지. 빠진 것만 채운다(SEC-014와 같은 원칙).
// - 실시간 집계가 시작된 지 GAP_FILL_DAYS일이 지났으면 받지 않는다(Yahoo가 일봉을 주지 않는 지표도 여기서 멈춤).
// - 일봉이 아직 없거나 집계가 아직 없으면 받는다(그동안 거래일이 지나가면 이음매에 빈 날이 생김).
// - 둘 다 있으면, 마지막 일봉과 집계 첫날 사이에 평일이 남아 있을 때만 받는다.
//   예: Yahoo가 어제 일봉을 아직 확정하지 않았고, 어제 종가 tick은 집계 갱신 범위를 지나 집계에 들어가지 않은 경우.
export function needsDailyHistory(lastDailyMs: number | null, firstAggMs: number | null, nowMs: number): boolean {
  if (firstAggMs !== null && nowMs - firstAggMs > GAP_FILL_DAYS * 86_400_000) return false;
  if (lastDailyMs === null || firstAggMs === null) return true;
  return weekdaysBetween(seoulDay(lastDailyMs), seoulDay(firstAggMs)) > 0;
}
