// 1일·1주 그래프 공백 판단과 봉 변환 (docs/Task_ORDER.md T-151, BENCHMARK B-58)
// 순수 함수만 둔다(테스트 대상). 받아 오기는 backfill.ts의 runIntradayFill, 저장은 db-sink가 한다.
// 집계에는 넣지 않는다: 원본이 지워진 구간을 다시 계산하면 다른 지표의 집계가 지워진다(저장 불변 조건).

import { BAR_RESOLUTION_MS, type BarResolution } from '../../shared/yahoo-bars.js';
import { MARKETS, type MarketId } from '../ingestion/market-hours.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// marginMs: 집계가 아직 만들어지는 중인 최근 구간은 공백으로 보지 않는다.
// 5분 봉은 갱신 정책의 end_offset 5분 + 주기 1분, 1시간 봉은 end_offset 1시간 + 주기 5분에 버킷 길이를 더한 값보다 조금 길게 둔다.
export const FILL_PLANS = {
  '5m': { view: 'market_5m', yahooInterval: '5m', windowMs: 24 * HOUR, fetchDays: 1.1, marginMs: 15 * MINUTE, minGapSlots: 3 },
  '1h': { view: 'market_1h', yahooInterval: '60m', windowMs: 7 * 24 * HOUR, fetchDays: 7.1, marginMs: 2 * HOUR + 10 * MINUTE, minGapSlots: 1 },
} as const satisfies Record<BarResolution, { view: string; yahooInterval: '5m' | '60m'; windowMs: number; fetchDays: number; marginMs: number; minGapSlots: number }>;

// 공휴일처럼 Yahoo에도 봉이 없는 공백 때문에 같은 지표를 하루 한 번보다 자주 받지 않는다 (T-127과 같은 값)
export const FILL_REFETCH_MS = 20 * HOUR;

const isOpen = (market: MarketId, ms: number) => MARKETS.find(item => item.id === market)?.isOpen(new Date(ms)) ?? false;

// 장이 열려 있어야 할 칸 중 값이 없는 칸의 수와, 가장 길게 이어진 길이를 돌려준다.
// 장이 닫힌 칸은 세지 않고 이어짐을 끊지도 않는다. 공휴일은 시간표로 알 수 없어 공백으로 나오며, 호출 횟수는 FILL_REFETCH_MS가 제한한다.
// lastFetchedMs: 이 지표·해상도를 Yahoo에서 마지막으로 받은 시각. 그때 이미 끝난 칸은 한 번 요청해 본 칸이므로, 비어 있으면 Yahoo에도 없는 칸이다
// (공휴일, 선물 일일 휴장, 국내 장 마감 직전처럼 봉을 주지 않는 시간). 다시 받아도 채워지지 않으므로 그 뒤의 칸만 본다. DB 값이라 재시작해도 유지된다.
// B-58: 이 조건이 없을 때 재시작 1회에 54개 중 35개를 다시 받고 새 행은 6개였다.
export function findGap(existing: Iterable<number>, market: MarketId, resolution: BarResolution, nowMs: number, lastFetchedMs: number | null = null) {
  const plan = FILL_PLANS[resolution];
  const step = BAR_RESOLUTION_MS[resolution];
  const present = new Set(existing);
  const windowStart = Math.ceil((nowMs - plan.windowMs) / step) * step;
  const first = lastFetchedMs === null ? windowStart : Math.max(windowStart, Math.floor(lastFetchedMs / step) * step);
  let missing = 0;
  let run = 0;
  let longestRun = 0;
  for (let slot = first; slot <= nowMs - plan.marginMs; slot += step) {
    if (present.has(slot)) {
      run = 0;
      continue;
    }
    if (!isOpen(market, slot)) continue;
    missing += 1;
    run += 1;
    longestRun = Math.max(longestRun, run);
  }
  return { missing, longestRun };
}

export const needsFill = (gap: { longestRun: number }, resolution: BarResolution) => gap.longestRun >= FILL_PLANS[resolution].minGapSlots;

export const fillDue = (lastFetchedMs: number | undefined, nowMs: number) => lastFetchedMs === undefined || nowMs - lastFetchedMs >= FILL_REFETCH_MS;

export interface IntradayQuote {
  date: Date;
  close?: number | null | undefined;
}

export interface FillRow {
  time: number;
  close: number;
}

// Yahoo 봉 → 집계 버킷 시각.
// - 집계 버킷은 "그 구간의 마지막 값"이고 봉의 종가는 봉이 끝날 때의 값이므로, 봉이 끝나기 직전 시각이 속한 버킷에 넣는다.
//   시작이 정각인 봉은 시작 시각 그대로이고, 미국 60분 봉(09:30 ~ 10:30)은 10:00 버킷이 되어 종가 시각이 버킷 안에 들어온다.
// - 아직 끝나지 않은 봉, 분 단위로 맞지 않는 봉(응답 끝에 붙는 현재가)은 넣지 않는다.
// - 같은 버킷에 두 봉이 오면 시각이 늦은 값을 쓴다.
export function toFillRows(quotes: IntradayQuote[], resolution: BarResolution, nowMs: number): FillRow[] {
  const step = BAR_RESOLUTION_MS[resolution];
  const byBucket = new Map<number, number>();
  for (const quote of quotes) {
    const start = quote.date.getTime();
    const { close } = quote;
    if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) continue;
    if (start % MINUTE !== 0 || start + step > nowMs) continue;
    byBucket.set(Math.floor((start + step - 1) / step) * step, close);
  }
  return [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, close: value }));
}
