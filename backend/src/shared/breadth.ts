// 시장 폭·거래대금 (docs/Task_ORDER.md T-106, D-67)
// KRX 종목별 일별 매매정보를 krx-collector가 시장별 합계로 줄여서 보낸다. 종목 행은 Kafka·DB에 남기지 않는다.
// Kafka `market-breadth` → db-sink → market_breadth 테이블 → REST `/api/v1/market/breadth`

import { isPlausibleEventTime } from './event-time.js';

export const BREADTH_MARKETS = ['KOSPI', 'KOSDAQ'] as const;
export type BreadthMarket = (typeof BREADTH_MARKETS)[number];

export interface MarketBreadth {
  market: BreadthMarket;
  time: number;          // 기준일의 장 마감 시각 15:30 KST (ms). KRX 일별 지수와 같은 규칙
  advancers: number;     // 상승 종목 수
  decliners: number;     // 하락 종목 수
  unchanged: number;     // 보합 종목 수
  stocks: number;        // 합계에 쓴 종목 수 (= 상승 + 하락 + 보합)
  tradingValue: number;  // 거래대금 합계 (원)
  collectedAt?: number;
  producedAt?: number;
}

const MARKET_SET = new Set<string>(BREADTH_MARKETS);
export const isBreadthMarket = (value: unknown): value is BreadthMarket => typeof value === 'string' && MARKET_SET.has(value);

export type BreadthParseResult = { ok: true; breadth: MarketBreadth } | { ok: false; reason: string };

// INTEGER 칼럼 범위 안 (T-154). 한 시장의 종목 수는 수천 개다
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
const isPositiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const fail = (reason: string): BreadthParseResult => ({ ok: false, reason });

// Kafka 메시지 검증. db-sink가 쓰고, 실패하면 사유를 돌려준다(예외를 던지지 않음, SEC-002). 알려진 필드만 남긴다.
export function parseMarketBreadth(value: Buffer | null): BreadthParseResult {
  if (!value || value.length === 0) return fail('empty');

  let data: unknown;
  try {
    data = JSON.parse(value.toString());
  } catch {
    return fail('invalid_json');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return fail('not_object');

  const { market, time, advancers, decliners, unchanged, stocks, tradingValue, collectedAt, producedAt } = data as Record<string, unknown>;
  if (!isBreadthMarket(market)) return fail('market');
  if (!isPlausibleEventTime(time)) return fail('time');
  if (!isCount(advancers) || !isCount(decliners) || !isCount(unchanged)) return fail('counts');
  if (!isCount(stocks) || stocks === 0 || stocks !== advancers + decliners + unchanged) return fail('stocks');
  if (typeof tradingValue !== 'number' || !Number.isFinite(tradingValue) || tradingValue < 0) return fail('trading_value');
  if (collectedAt !== undefined && !isPositiveNumber(collectedAt)) return fail('collected_at');
  if (producedAt !== undefined && !isPositiveNumber(producedAt)) return fail('produced_at');

  const breadth: MarketBreadth = { market, time, advancers, decliners, unchanged, stocks, tradingValue };
  if (collectedAt !== undefined) breadth.collectedAt = collectedAt as number;
  if (producedAt !== undefined) breadth.producedAt = producedAt as number;
  return { ok: true, breadth };
}
