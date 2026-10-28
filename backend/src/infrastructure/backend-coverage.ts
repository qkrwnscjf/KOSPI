// 이미 저장된 기간 확인 (docs/security.md SEC-014)
// 수집기는 DB 접속 정보가 없으므로(권한 최소화), 시작할 때 backend의 읽기 전용 API로 저장 범위만 묻는다.
// - Docker 내부 네트워크(BACKEND_URL, compose에서는 http://backend:3001)로만 호출하고, 인증키는 보내지 않는다.
// - 공통 호출 함수(http-json.ts)를 써서 리다이렉트 거부·크기 상한·시간 제한을 똑같이 적용한다.
// - 실패하면 null을 돌려준다. 호출하는 쪽은 null이면 과거 채우기를 미루고 다음 주기에 다시 묻는다(재시작 반복 시 대량 호출 방지).

import { fetchJson } from './http-json.js';
import { isMarketState, type MarketState } from '../shared/market-state.js';

const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:3001').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface DateCoverage {
  earliest: string; // YYYYMMDD
  latest: string;   // YYYYMMDD
}

const seoulDay = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');

async function getJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchJson(`${BACKEND_URL}${path}`, { timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES });
    return response.ok && response.body && typeof response.body === 'object' && !Array.isArray(response.body)
      ? (response.body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// KRX 일별 지수: 심볼마다 저장된 첫 날짜·마지막 날짜. 심볼이 비어 있으면 그 심볼은 earliest/latest 없음(null).
// 모든 심볼을 확인하지 못하면 null.
export async function fetchDailyIndexCoverage(symbols: readonly string[]): Promise<Map<string, DateCoverage | null> | null> {
  const result = new Map<string, DateCoverage | null>();
  for (const symbol of symbols) {
    const body = await getJson(`/api/v1/market/history?ticker=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent('1년')}`);
    if (!body || !Array.isArray(body.data)) return null;
    const times = body.data
      .map(point => (point && typeof point === 'object' ? (point as Record<string, unknown>).time : undefined))
      .filter((time): time is number => typeof time === 'number' && Number.isFinite(time));
    result.set(symbol, times.length === 0 ? null : { earliest: seoulDay(Math.min(...times)), latest: seoulDay(Math.max(...times)) });
  }
  return result;
}

// 시장 폭 (T-106): 시장별 저장된 첫 날짜·마지막 날짜. 저장된 것이 없는 시장은 null, 확인하지 못하면 null.
export async function fetchBreadthCoverage(markets: readonly string[]): Promise<Map<string, DateCoverage | null> | null> {
  const body = await getJson(`/api/v1/market/breadth?range=${encodeURIComponent('1년')}`);
  const coverage = body?.coverage;
  if (!body || !coverage || typeof coverage !== 'object' || Array.isArray(coverage)) return null;
  const result = new Map<string, DateCoverage | null>();
  for (const market of markets) {
    const item = (coverage as Record<string, unknown>)[market];
    const { since, until } = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    result.set(market, typeof since === 'string' && typeof until === 'string' && ISO_DATE.test(since) && ISO_DATE.test(until)
      ? { earliest: since.replace(/-/g, ''), latest: until.replace(/-/g, '') }
      : null);
  }
  return result;
}

// 종목 순위 (T-113): 시장별 저장된 첫 날짜·마지막 날짜. 저장된 것이 없는 시장은 null, 확인하지 못하면 null.
export async function fetchRankingsCoverage(markets: readonly string[]): Promise<Map<string, DateCoverage | null> | null> {
  const body = await getJson('/api/v1/market/rankings?market=KOSPI&type=cap');
  const coverage = body?.coverage;
  if (!body || !coverage || typeof coverage !== 'object' || Array.isArray(coverage)) return null;
  const result = new Map<string, DateCoverage | null>();
  for (const market of markets) {
    const item = (coverage as Record<string, unknown>)[market];
    const { since, until } = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    result.set(market, typeof since === 'string' && typeof until === 'string' && ISO_DATE.test(since) && ISO_DATE.test(until)
      ? { earliest: since.replace(/-/g, ''), latest: until.replace(/-/g, '') }
      : null);
  }
  return result;
}

// worker 재시작 중복 방지 (T-133): 지표별 마지막 전송 tick의 소스 시각·장 상태. 확인하지 못하면 null
export interface LatestTickTime { symbol: string; timestamp: number; marketState?: MarketState }

export function parseLatestTickTimes(body: Record<string, unknown>): LatestTickTime[] | null {
  if (!Array.isArray(body.data)) return null;
  const result: LatestTickTime[] = [];
  for (const item of body.data.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue;
    const { symbol, timestamp, marketState } = item as Record<string, unknown>;
    if (typeof symbol !== 'string' || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue;
    result.push(isMarketState(marketState) ? { symbol, timestamp, marketState } : { symbol, timestamp });
  }
  return result;
}

export async function fetchLatestTickTimes(): Promise<LatestTickTime[] | null> {
  const body = await getJson('/api/v1/market/latest-times');
  return body ? parseLatestTickTimes(body) : null;
}

// DART 공시: 저장된 첫 접수일·마지막 접수일. 저장된 것이 없으면 earliest/latest가 null인 객체, 확인하지 못하면 null.
export async function fetchDisclosureCoverage(): Promise<{ coverage: DateCoverage | null } | null> {
  const body = await getJson('/api/v1/disclosures/recent?group=all');
  const coverage = body?.coverage;
  if (!body || !coverage || typeof coverage !== 'object') return null;
  const { since, until } = coverage as Record<string, unknown>;
  if (typeof since === 'string' && typeof until === 'string' && ISO_DATE.test(since) && ISO_DATE.test(until)) {
    return { coverage: { earliest: since.replace(/-/g, ''), latest: until.replace(/-/g, '') } };
  }
  return { coverage: null };
}
