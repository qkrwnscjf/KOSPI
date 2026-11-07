import type { FastifyInstance } from 'fastify';
import { cache } from '../../infrastructure/redis.js';
import { dbPool } from '../../infrastructure/db.js';
import { Latency } from '../../infrastructure/metrics.js';
import { MARKET_FLOW_METRICS } from '../../shared/market-flows.js';

// 증시 자금 흐름 조회 API. 투자자별 순매수 API(`/api/v1/flows/investors`)는 데이터 원천이 없어 T-164에서 지웠다.

const flowsDuration = new Latency('kospi_flows_request_duration_seconds', 'Market flows API response time by result');

// 증시 자금 흐름 일별 통계 (11단계 B′ T-97 · T-98, D-77): GET /api/v1/flows/market
// 화면은 최근 1개월만 보여 주므로 기간은 고정(입력 없음). 지표는 확정된 고정 목록(MARKET_FLOW_METRICS)만 매개변수로 넘긴다.
// 값은 원 단위(비중은 %), 일별이라 60초 캐시.
const MARKET_FLOWS_RANGE = '31 days';
const MARKET_FLOWS_CACHE_TTL_S = 60;
const MARKET_FLOW_KEYS = Object.keys(MARKET_FLOW_METRICS);

async function getMarketFlows() {
  const { rows } = await dbPool.query<{ metric: string; time: number; value: number }>(
    `SELECT metric, (extract(epoch FROM time) * 1000)::float8 AS time, value::float8 AS value
     FROM market_flows
     WHERE metric = ANY($1::text[]) AND time >= now() - $2::interval
     ORDER BY time`,
    [MARKET_FLOW_KEYS, MARKET_FLOWS_RANGE]
  );
  const latest = rows.reduce((max, row) => Math.max(max, row.time), 0);
  return {
    range: '1개월',
    latestTime: latest > 0 ? latest : null,
    metrics: MARKET_FLOW_KEYS.map(metric => ({
      metric,
      label: MARKET_FLOW_METRICS[metric]?.label ?? metric,
      unit: MARKET_FLOW_METRICS[metric]?.unit ?? 'KRW',
      points: rows.filter(row => row.metric === metric).map(row => ({ time: row.time, value: row.value })),
    })),
  };
}

export const flowsController = async (fastify: FastifyInstance) => {
  fastify.get('/api/v1/flows/market', async (_request, reply) => {
    const startedAt = Date.now();
    try {
      const cacheKey = 'flows:market:1개월';
      const cached = await cache.readJson(cacheKey);
      if (cached) {
        flowsDuration.observe({ result: 'cache_hit' }, Date.now() - startedAt);
        return cached;
      }
      const payload = await getMarketFlows();
      cache.writeJson(cacheKey, payload, MARKET_FLOWS_CACHE_TTL_S);
      flowsDuration.observe({ result: 'cache_miss' }, Date.now() - startedAt);
      return payload;
    } catch (err) {
      flowsDuration.observe({ result: 'error' }, Date.now() - startedAt);
      console.error('Error fetching market flows:', err instanceof Error ? err.message : String(err));
      return reply.code(500).send({ error: 'Failed to fetch market flows' });
    }
  });
};
