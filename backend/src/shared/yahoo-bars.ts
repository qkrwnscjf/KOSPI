// Yahoo 장중 봉 메시지 (docs/Task_ORDER.md T-151, BENCHMARK B-58)
// 스택이 꺼져 있던 구간의 1일·1주 그래프를 채우는 5분·1시간 종가. db-sink가 Yahoo chart로 받아 Kafka `yahoo-bars`로 보내고,
// 같은 db-sink의 컨슈머가 검증 후 market_bars_fill에 저장한다. Gateway는 이 토픽을 읽지 않는다(지난 값이라 화면에 보내지 않음).

import { isYahooSymbolKey, type YahooSymbolKey } from './symbols.js';
import { isPlausibleEventTime } from './event-time.js';

export const BAR_RESOLUTIONS = ['5m', '1h'] as const;
export type BarResolution = (typeof BAR_RESOLUTIONS)[number];
export const BAR_RESOLUTION_MS: Record<BarResolution, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 };

export interface YahooBarMessage {
  symbol: YahooSymbolKey;
  resolution: BarResolution;
  time: number;        // 집계 버킷과 같은 경계로 맞춘 시각 (ms)
  close: number;
  producedAt?: number;
}

export type YahooBarParseResult = { ok: true; row: YahooBarMessage } | { ok: false; reason: string };

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isResolution = (value: unknown): value is BarResolution => BAR_RESOLUTIONS.includes(value as BarResolution);
const fail = (reason: string): YahooBarParseResult => ({ ok: false, reason });

// 잘못된 메시지는 예외를 던지지 않고 사유를 돌려준다 (SEC-002)
export function parseYahooBar(value: Buffer | null): YahooBarParseResult {
  if (!value || value.length === 0) return fail('empty');
  let data: unknown;
  try {
    data = JSON.parse(value.toString());
  } catch {
    return fail('invalid_json');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return fail('not_object');
  const { symbol, resolution, time, close, producedAt } = data as Record<string, unknown>;
  if (typeof symbol !== 'string' || !isYahooSymbolKey(symbol)) return fail('symbol');
  if (!isResolution(resolution)) return fail('resolution');
  if (!isPlausibleEventTime(time) || time % BAR_RESOLUTION_MS[resolution] !== 0) return fail('time');
  if (!isFiniteNumber(close) || close <= 0) return fail('close');
  if (producedAt !== undefined && (!isFiniteNumber(producedAt) || producedAt <= 0)) return fail('produced_at');
  const row: YahooBarMessage = { symbol, resolution, time, close };
  if (producedAt !== undefined) row.producedAt = producedAt;
  return { ok: true, row };
}
