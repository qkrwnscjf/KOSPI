import type { FastifyInstance } from 'fastify';
import { cache } from '../../infrastructure/redis.js';
import { dbPool } from '../../infrastructure/db.js';
import { Latency } from '../../infrastructure/metrics.js';
import { isFlowMarket, type FlowMarket } from '../../shared/flows.js';
import { MARKET_FLOW_METRICS } from '../../shared/market-flows.js';

// 증시 자금 흐름 조회 API (docs/Task_ORDER.md 11단계 A, T-63)
// GET /api/v1/flows/investors?market=KOSPI&range=1일
// - 1일: 가장 최근 거래일의 장중 추이(잠정치, 분 단위)
// - 1주 ~ 1년: 거래일별 마지막 값(확정치가 있으면 확정치)
// 시장·기간은 고정된 표에서만 고르고, 값은 매개변수로만 SQL에 넘긴다.

const flowsDuration = new Latency('kospi_flows_request_duration_seconds', 'Investor flows API response time by result');

const DAILY_RANGES: Record<string, string> = {
  '1주': '7 days',
  '1개월': '30 days',
  '3개월': '90 days',
  '1년': '365 days',
};
const INTRADAY = '1일';
const CACHE_TTL_S = 15;

interface FlowPoint {
  time: number;
  foreignNet: number;
  institutionNet: number;
  individualNet: number;
  status: string;
}

async function getIntraday(market: FlowMarket): Promise<FlowPoint[]> {
  const { rows } = await dbPool.query<FlowPoint>(
    `WITH latest AS (SELECT max(time) AS t FROM investor_flows WHERE market = $1)
     SELECT (extract(epoch FROM f.time) * 1000)::float8 AS time,
            f.foreign_net AS "foreignNet", f.institution_net AS "institutionNet", f.individual_net AS "individualNet", f.status
     FROM investor_flows f, latest
     WHERE f.market = $1 AND latest.t IS NOT NULL
       AND f.time >= (date_trunc('day', latest.t AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')
     ORDER BY f.time`,
    [market]
  );
  return rows;
}

async function getDaily(market: FlowMarket, range: string): Promise<FlowPoint[]> {
  const { rows } = await dbPool.query<FlowPoint>(
    `SELECT (extract(epoch FROM time_bucket(INTERVAL '1 day', time, 'Asia/Seoul')) * 1000)::float8 AS time,
            last(foreign_net, time) AS "foreignNet", last(institution_net, time) AS "institutionNet",
            last(individual_net, time) AS "individualNet", last(status, time) AS status
     FROM investor_flows
     WHERE market = $1 AND time >= now() - $2::interval
     GROUP BY 1
     ORDER BY 1`,
    [market, range]
  );
  return rows;
}

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

  fastify.get('/api/v1/flows/investors', async (request, reply) => {
    const startedAt = Date.now();
    const { market, range } = request.query as { market?: string; range?: string };

    if (!isFlowMarket(market) || !range || (range !== INTRADAY && !DAILY_RANGES[range])) {
      return reply.code(400).send({ error: 'a known market and range are required' });
    }

    try {
      const cacheKey = `flows:${market}:${range}`;
      const cached = await cache.readJson(cacheKey);
      if (cached) {
        flowsDuration.observe({ result: 'cache_hit' }, Date.now() - startedAt);
        return cached;
      }

      const dailyInterval = DAILY_RANGES[range];
      const data = range === INTRADAY || !dailyInterval ? await getIntraday(market) : await getDaily(market, dailyInterval);
      const payload = { market, range, unit: 'million_krw', data };
      cache.writeJson(cacheKey, payload, CACHE_TTL_S);
      flowsDuration.observe({ result: 'cache_miss' }, Date.now() - startedAt);
      return payload;
    } catch (err) {
      flowsDuration.observe({ result: 'error' }, Date.now() - startedAt);
      console.error(`Error fetching investor flows for ${market}:`, err);
      return reply.code(500).send({ error: 'Failed to fetch investor flows' });
    }
  });
};
