// KRX 지수 일별 시세 → TickData 정규화 (docs/Task_ORDER.md T-67, D-60)
//
// ⚠️ 미확인 사항: 엔드포인트 경로와 응답 필드 이름(OutBlock_1, IDX_NM, CLSPRC_IDX, CMPPREV_IDX, FLUC_RT)은
// KRX Open API의 알려진 형식을 따른 가정이다. 첫 응답에서 필드 이름(값 제외)을 한 번 로그로 남겨 확정한다.
// 필드가 맞지 않으면 값을 0으로 채우지 않고 건너뛴다.

import { isKrxDailySymbol, KRX_DAILY_INDICES, symbolForIndexName, type KrxEndpoint, type KrxDailySymbol, type KrxHistorySymbol } from '../../shared/krx-indices.js';
import type { TickData } from '../../shared/types.js';

export const ENDPOINT_PATHS: Record<KrxEndpoint, string> = {
  krx: '/idx/krx_dd_trd',
  drvprod: '/idx/drvprod_dd_trd',
  kospi: '/idx/kospi_dd_trd', // KOSPI 시리즈 일별 시세 (T-104 보완: 코스피 200 과거 일봉)
};

// 2026-10-21 실제 응답으로 확인: IDX_NM, CLSPRC_IDX, CMPPREVDD_IDX(전일 대비), FLUC_RT
export const FIELDS = {
  name: 'IDX_NM',
  close: 'CLSPRC_IDX',
  change: 'CMPPREVDD_IDX',
  changeRate: 'FLUC_RT',
} as const;
// 엔드포인트에 따라 전일 대비 필드 이름이 다를 수 있어서 예전 이름도 받는다
const CHANGE_FIELD_FALLBACK = 'CMPPREV_IDX';

// 숫자 문자열을 숫자로. 빈 값·'-'·숫자가 아닌 값은 null (0으로 대체하지 않음, D-14와 같은 원칙)
export function parseKrxNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/,/g, '');
  if (trimmed === '' || trimmed === '-') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

// 기준일(YYYYMMDD)의 장 마감 시각(15:30 KST = 06:30 UTC)을 값의 기준 시각으로 쓴다
export function closeTimestamp(basDd: string): number {
  const year = Number(basDd.slice(0, 4));
  const month = Number(basDd.slice(4, 6));
  const day = Number(basDd.slice(6, 8));
  return Date.UTC(year, month - 1, day, 6, 30);
}

// 서울 기준 날짜 목록(YYYYMMDD, 오래된 날부터). 주말은 거래일이 아니라서 건너뛴다. 공휴일은 응답이 비어서 자연히 건너뛴다.
export function seoulWeekdays(nowMs: number, days: number): string[] {
  const result: string[] = [];
  for (let offset = days; offset >= 0; offset -= 1) {
    const date = new Date(nowMs + 9 * 3600_000 - offset * 86_400_000); // 한국은 서머타임이 없어 +9시간 고정
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    result.push(date.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return result;
}

// 서울 기준 오늘보다 이전의 평일만 (오늘 값은 아직 확정되지 않았거나 실시간 수집이 맡음).
// 목록의 마지막 칸을 잘라 내는 방식은 주말에 금요일을 빠뜨리므로 날짜로 비교한다.
export function pastSeoulWeekdays(nowMs: number, days: number): string[] {
  const today = new Date(nowMs + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
  return seoulWeekdays(nowMs, days).filter(date => date < today);
}

// 과거 채우기에서 실제로 받을 날짜 (docs/security.md SEC-014)
// - targetDates: 채우려는 날짜(YYYYMMDD, 오래된 날부터), coverage: 이미 저장된 범위(없으면 null = 전부 받음)
// - 저장된 마지막 날짜 이후와, 저장된 첫 날짜 이전 중 목표 시작일에서 toleranceDays 넘게 비어 있는 부분만 받는다.
//   (목표 시작일 근처 며칠은 휴장일·History API 범위 차이 때문에 비어 있을 수 있어 매번 다시 받지 않게 함)
export function missingDates(targetDates: string[], coverage: { earliest: string; latest: string } | null, toleranceDays = 10): string[] {
  if (!coverage) return targetDates;
  const first = targetDates[0];
  if (!first) return [];
  const toleranceEdge = shiftDate(first, toleranceDays);
  const fillOlder = coverage.earliest > toleranceEdge;
  return targetDates.filter(date => date > coverage.latest || (fillOlder && date < coverage.earliest));
}

// 저장된 범위 사이의 빈 날 (T-141): 심볼마다 저장된 날짜 집합을 보고, 그 심볼의 첫 저장일과 마지막 저장일 사이인데 없는 날짜를 돌려준다.
// targetDates는 오래된 날부터. 저장된 것이 없는 심볼은 여기서 보지 않는다(missingDates가 전부 받음).
export function internalGaps(targetDates: string[], storedDays: readonly ReadonlySet<string>[]): string[] {
  const gaps = new Set<string>();
  for (const days of storedDays) {
    if (days.size === 0) continue;
    const sorted = [...days].sort();
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    for (const date of targetDates) if (date > first && date < last && !days.has(date)) gaps.add(date);
  }
  return targetDates.filter(date => gaps.has(date));
}

// YYYYMMDD에 일수를 더한다
export function shiftDate(date: string, days: number) {
  const ms = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

// 여러 심볼의 저장 범위를 하나로: 모두에게 있는 범위(첫 날짜는 가장 늦은 것, 마지막 날짜는 가장 이른 것).
// 한 심볼이라도 비어 있으면 null (전부 받음)
export function combineCoverage(coverages: ({ earliest: string; latest: string } | null | undefined)[]) {
  if (coverages.length === 0 || coverages.some(item => !item)) return null;
  const items = coverages as { earliest: string; latest: string }[];
  return {
    earliest: items.reduce((max, item) => (item.earliest > max ? item.earliest : max), items[0]!.earliest),
    latest: items.reduce((min, item) => (item.latest < min ? item.latest : min), items[0]!.latest),
  };
}

export function rowsOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const block = body.OutBlock_1;
  return Array.isArray(block) ? block.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object') : [];
}

// 순수 함수 (테스트 대상): 응답 행들 → 대상 지수의 tick. 대상이 아닌 지수는 버린다.
export function mapIndexRows(endpoint: KrxEndpoint, basDd: string, rows: Record<string, unknown>[]) {
  const ticks: TickData[] = [];
  const invalid: (KrxDailySymbol | KrxHistorySymbol)[] = [];
  const timestamp = closeTimestamp(basDd);
  for (const row of rows) {
    const name = row[FIELDS.name];
    if (typeof name !== 'string') continue;
    const symbol = symbolForIndexName(endpoint, name);
    if (!symbol) continue;
    const price = parseKrxNumber(row[FIELDS.close]);
    const changeRate = parseKrxNumber(row[FIELDS.changeRate]);
    const changePrice = parseKrxNumber(row[FIELDS.change]) ?? parseKrxNumber(row[CHANGE_FIELD_FALLBACK]);
    if (price === null || price <= 0 || changeRate === null) {
      invalid.push(symbol);
      continue;
    }
    // 과거 일봉 전용 심볼(코스피 200 등)은 국내 지표다
    const category = isKrxDailySymbol(symbol) ? KRX_DAILY_INDICES[symbol].category : 'domestic';
    const tick: TickData = { symbol, category, price, changeRate, timestamp };
    if (changePrice !== null) tick.changePrice = changePrice;
    ticks.push(tick);
  }
  return { ticks, invalid };
}
