// Yahoo 일봉 메시지 (docs/Task_ORDER.md T-143, BENCHMARK B-53)
// db-sink가 Yahoo chart로 받은 일봉을 DB에 바로 쓰지 않고 Kafka `yahoo-daily`로 보낸 뒤, 같은 db-sink의 컨슈머가 저장한다.
// 다른 데이터와 같은 경로(검증 → DLQ, 저장 성공 뒤 오프셋 확정, 재처리)를 쓰기 위함이다. Gateway는 이 토픽을 읽지 않는다(지난 값이라 화면에 보내지 않음).
// overwrite: false = 없는 날짜만 넣기(과거 일봉·빈 날 채우기), true = Yahoo 행은 새 값으로 바꾸기(공식 종가 보정, T-136)

import { isYahooSymbolKey, type YahooSymbolKey } from './symbols.js';

export interface YahooDailyMessage {
  symbol: YahooSymbolKey;
  time: number;        // 거래일 15:30 KST (ms), KRX 일별 값과 같은 기준
  close: number;
  changeRate: number;
  changePrice: number;
  overwrite: boolean;
  producedAt?: number;
}

export type YahooDailyParseResult = { ok: true; row: YahooDailyMessage } | { ok: false; reason: string };

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const fail = (reason: string): YahooDailyParseResult => ({ ok: false, reason });

// 잘못된 메시지는 예외를 던지지 않고 사유를 돌려준다 (SEC-002)
export function parseYahooDaily(value: Buffer | null): YahooDailyParseResult {
  if (!value || value.length === 0) return fail('empty');
  let data: unknown;
  try {
    data = JSON.parse(value.toString());
  } catch {
    return fail('invalid_json');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return fail('not_object');
  const { symbol, time, close, changeRate, changePrice, overwrite, producedAt } = data as Record<string, unknown>;
  if (typeof symbol !== 'string' || !isYahooSymbolKey(symbol)) return fail('symbol');
  if (!isFiniteNumber(time) || time <= 0) return fail('time');
  if (!isFiniteNumber(close) || close <= 0) return fail('close');
  if (!isFiniteNumber(changeRate)) return fail('change_rate');
  if (!isFiniteNumber(changePrice)) return fail('change_price');
  if (typeof overwrite !== 'boolean') return fail('overwrite');
  if (producedAt !== undefined && (!isFiniteNumber(producedAt) || producedAt <= 0)) return fail('produced_at');
  const row: YahooDailyMessage = { symbol, time, close, changeRate, changePrice, overwrite };
  if (producedAt !== undefined) row.producedAt = producedAt;
  return { ok: true, row };
}
