import type { FastifyInstance } from 'fastify';
import { redis } from '../../infrastructure/redis.js';
import { marketService } from '../market/market.service.js';

// 검증용 REST 점검 (기본 끔, BENCHMARK B-56, 스위치 REST_SELF_CHECK=true)
// 에이전트는 curl을 쓸 수 없어서, backend가 자기 라우트를 내부 호출(fastify.inject, 네트워크 없음)해 결과를 남긴다.
// 로그에는 라우트, 상태 코드, 시간, Redis 상태만 남긴다(응답 내용 없음). 라우트는 고정 목록이다.
const INTERVAL_MS = 5000;
const q = encodeURIComponent;
const ROUTES = [
  `/api/v1/market/history?ticker=KOSPI&timeframe=${q('1주')}`,
  `/api/v1/market/history?ticker=KOSPI&timeframe=${q('1개월')}`,
  '/api/v1/market/recent?ticker=KOSPI',
  `/api/v1/market/sector-returns?range=${q('1개월')}`,
  `/api/v1/market/breadth?range=${q('1개월')}`,
  '/api/v1/market/rankings?market=KOSPI&type=cap',
  `/api/v1/market/risk?range=${q('1개월')}`,
  '/api/v1/flows/market',
  '/api/v1/disclosures/recent?group=all',
  `/api/v1/disclosures/capital-events?range=${q('1개월')}`,
  `/api/v1/disclosures/calendar?month=${new Date().toISOString().slice(0, 7)}`,
  '/api/v1/system/pipeline',
  '/api/v1/market/source-lags', // T-162
];

// 구독 첫 값 읽기 비교 (B-63): 이전 방식(Redis를 기다림)과 지금 방식의 시간. 공개 시세의 있음·없음만 남긴다
async function logSubscribeCheck() {
  const timed = async (run: () => Promise<unknown>) => {
    const startedAt = Date.now();
    try {
      const value = await run();
      return { ms: Date.now() - startedAt, found: value !== null };
    } catch {
      return { ms: Date.now() - startedAt, error: true };
    }
  };
  const guarded = await timed(() => marketService.readLatestTickForSubscribe('KOSPI'));
  const daily = await timed(async () => (await marketService.readLatestTickForSubscribe('KRX_SEMI')) ?? marketService.getLatestDailyIndex('KRX_SEMI'));
  const previous = await timed(() => marketService.getLatestTick('KOSPI'));
  console.log(`[subscribe-check] ${JSON.stringify({ guarded, daily, previous })}`);
}

export function startRestSelfCheck(fastify: FastifyInstance) {
  if (process.env.REST_SELF_CHECK !== 'true') return;
  void (async function loop() {
    await logSubscribeCheck();
    setTimeout(() => void loop(), 5000);
  })();
  console.warn(`REST_SELF_CHECK=true: calling ${ROUTES.length} REST routes internally every 5s (verification only).`);
  const run = async () => {
    const redisAtStart = redis.status;
    const startedAt = Date.now();
    const results: { route: string; status: number; ms: number }[] = [];
    for (const url of ROUTES) {
      const routeStart = Date.now();
      const response = await fastify.inject({ method: 'GET', url });
      results.push({ route: url.split('?')[0]?.replace('/api/v1/', '') ?? url, status: response.statusCode, ms: Date.now() - routeStart });
    }
    const ok = results.filter(result => result.status >= 200 && result.status < 300).length;
    console.log(`[rest-check] ${JSON.stringify({ redis: redisAtStart, ok, total: results.length, totalMs: Date.now() - startedAt, maxMs: Math.max(...results.map(result => result.ms)), results })}`);
    setTimeout(() => void run().catch(error => console.error(`[rest-check] failed: ${error instanceof Error ? error.message : 'unexpected_error'}`)), INTERVAL_MS);
  };
  void run().catch(error => console.error(`[rest-check] failed: ${error instanceof Error ? error.message : 'unexpected_error'}`));
}
