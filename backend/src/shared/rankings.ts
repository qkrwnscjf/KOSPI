// 종목 순위 (docs/Task_ORDER.md 15단계 T-113, D-72)
// KRX 종목별 일별매매정보(krx-collector가 이미 받는 응답)에서 시장·날짜마다 4가지 순위의 상위 100개만 남긴다:
// 상승률·하락률·거래대금·시가총액. 한 종목이 여러 순위에 들면 한 행에 순위를 함께 담는다(시장·날짜마다 최대 400행).
// Kafka `stock-rankings`(시장·날짜마다 메시지 1건) → db-sink → stock_rankings(1년) → REST `/api/v1/market/rankings`
// 종목명·종목코드는 공개 정보다. 나머지 종목(상위 100 밖)은 저장하지 않는다.

import { BREADTH_MARKETS, isBreadthMarket, type BreadthMarket } from './breadth.js';
import { isPlausibleEventTime } from './event-time.js';

export const RANKING_LIMIT = 100;
export const RANKING_TYPES = ['gain', 'loss', 'value', 'cap'] as const;
export type RankingType = (typeof RANKING_TYPES)[number];
export const isRankingType = (value: unknown): value is RankingType => typeof value === 'string' && (RANKING_TYPES as readonly string[]).includes(value);
export { BREADTH_MARKETS as RANKING_MARKETS, isBreadthMarket as isRankingMarket };

export interface RankingEntry {
  code: string;                 // 종목코드 (6자리 영숫자)
  name: string;                 // 종목명
  close: number;                // 종가 (원)
  changeRate: number | null;    // 등락률 (%)
  tradingValue: number | null;  // 거래대금 (원)
  marketCap: number | null;     // 시가총액 (원)
  ranks: Partial<Record<RankingType, number>>;
}

export interface StockRankings {
  market: BreadthMarket;
  time: number;                 // 기준일 15:30 KST (ms), 시장 폭·KRX 일별 지수와 같은 기준
  entries: RankingEntry[];
  collectedAt?: number;
  producedAt?: number;
}

export const STOCK_CODE_PATTERN = /^[0-9A-Z]{6}$/;
const MAX_NAME_LENGTH = 60;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function cleanStockName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(UNSAFE_TEXT, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return text.length > 0 ? text : null;
}

export type RankingsParseResult = { ok: true; rankings: StockRankings } | { ok: false; reason: string };
const fail = (reason: string): RankingsParseResult => ({ ok: false, reason });
const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isNullableNumber = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value));
const isRank = (value: unknown) => value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= RANKING_LIMIT);

// Kafka 메시지 검증 (db-sink). 예외를 던지지 않는다 (SEC-002). 알려진 필드만 남긴다.
export function parseStockRankings(value: Buffer | null): RankingsParseResult {
  if (!value || value.length === 0) return fail('empty');
  let data: unknown;
  try {
    data = JSON.parse(value.toString());
  } catch {
    return fail('invalid_json');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return fail('not_object');
  const { market, time, entries, collectedAt, producedAt } = data as Record<string, unknown>;
  if (!isBreadthMarket(market)) return fail('market');
  if (!isPlausibleEventTime(time)) return fail('time');
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > RANKING_LIMIT * RANKING_TYPES.length) return fail('entries');

  const parsed: RankingEntry[] = [];
  const codes = new Set<string>();
  for (const item of entries) {
    if (!item || typeof item !== 'object') return fail('entry');
    const { code, name, close, changeRate, tradingValue, marketCap, ranks } = item as Record<string, unknown>;
    const cleanName = cleanStockName(name);
    if (typeof code !== 'string' || !STOCK_CODE_PATTERN.test(code) || codes.has(code)) return fail('code');
    if (!cleanName || !isPositive(close)) return fail('entry');
    if (!isNullableNumber(changeRate) || !isNullableNumber(tradingValue) || !isNullableNumber(marketCap)) return fail('entry');
    if (!ranks || typeof ranks !== 'object') return fail('ranks');
    const rankRecord = ranks as Record<string, unknown>;
    if (!RANKING_TYPES.every(type => isRank(rankRecord[type])) || !RANKING_TYPES.some(type => rankRecord[type] !== undefined)) return fail('ranks');
    codes.add(code);
    const cleanRanks: Partial<Record<RankingType, number>> = {};
    for (const type of RANKING_TYPES) if (typeof rankRecord[type] === 'number') cleanRanks[type] = rankRecord[type] as number;
    parsed.push({ code, name: cleanName, close, changeRate, tradingValue, marketCap, ranks: cleanRanks });
  }
  const rankings: StockRankings = { market, time, entries: parsed };
  if (isPositive(collectedAt)) rankings.collectedAt = collectedAt;
  if (isPositive(producedAt)) rankings.producedAt = producedAt;
  return { ok: true, rankings };
}
