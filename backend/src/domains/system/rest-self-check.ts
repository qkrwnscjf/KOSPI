import type { FastifyInstance } from 'fastify';
import { redis } from '../../infrastructure/redis.js';

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
];

export function startRestSelfCheck(fastify: FastifyInstance) {
  if (process.env.REST_SELF_CHECK !== 'true') return;
  console.warn('REST_SELF_CHECK=true: calling 12 REST routes internally every 5s (verification only).');
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
