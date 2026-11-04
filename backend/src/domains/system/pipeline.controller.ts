import type { FastifyInstance } from 'fastify';
import { cache } from '../../infrastructure/redis.js';
import { fetchJson } from '../../infrastructure/http-json.js';
import { TOPICS } from '../../infrastructure/kafka.js';
import { Latency } from '../../infrastructure/metrics.js';
import { dbJobName, parseVector, type Sample } from '../../shared/prometheus.js';

// 데이터 파이프라인 상태 (docs/Task_ORDER.md 15단계 T-112, D-72)
// GET /api/v1/system/pipeline → 앱 설정 화면의 "파이프라인 상태". 같은 지표를 Grafana 대시보드에서도 본다.
// - Prometheus(Docker 내부 주소 PROMETHEUS_URL)에 고정된 쿼리만 보낸다. 요청 값은 받지 않는다.
// - 공통 호출 보호(fetchJson: 시간 제한·리다이렉트 거부·크기 상한). Prometheus에 닿지 않으면 그 사실만 알린다.
// - 서비스 이름·건수·경과 시간만 돌려준다. 접속 정보·환경변수·오류 원문은 넣지 않는다.
//   배포할 때는 내부 구조가 드러나는 화면이라 공개 범위를 다시 정한다 (SEC-005와 같은 성격).

const PROMETHEUS_URL = (process.env.PROMETHEUS_URL || 'http://localhost:9090').replace(/\/+$/, '');
const QUERY_TIMEOUT_MS = 3000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const CACHE_TTL_S = 15;

const statusDuration = new Latency('kospi_pipeline_status_duration_seconds', 'Pipeline status API response time by result');

// 고정 쿼리 (이름 → PromQL)
const QUERIES = {
  up: 'up',
  consumerLag: 'sum by (consumergroup) (kafka_consumergroup_lag)',
  dlq: 'sum by (topic) (kafka_topic_partition_current_offset{topic=~".+\\\\.dlq"})',
  yahoo: 'sum by (result) (increase(kospi_worker_fetch_total{source="yahoo"}[15m]))',
  krxAge: 'max by (endpoint) (time() - kospi_krx_last_success_timestamp_seconds)',
  dartAge: 'max(time() - kospi_disclosure_last_success_timestamp_seconds)',
  gatewayKafka: 'max(kospi_gateway_kafka_connected)',
  wsConnections: 'sum(kospi_ws_connections)',
  dataAge: 'kospi_db_latest_data_age_seconds',
  dbSize: 'sum(kospi_db_size_bytes)',
  dbJobFailures: 'kospi_db_job_failures',
  dbJobDelay: 'kospi_db_job_last_success_age_seconds / kospi_db_job_schedule_seconds',
} as const;
type QueryName = keyof typeof QUERIES;
const KNOWN_DLQ_TOPICS = new Set<string>(Object.values(TOPICS).filter(topic => topic.endsWith('.dlq')));

async function query(name: QueryName): Promise<Sample[] | null> {
  try {
    const response = await fetchJson(`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(QUERIES[name])}`, {
      timeoutMs: QUERY_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES,
    });
    return response.ok ? parseVector(response.body) : null;
  } catch {
    return null;
  }
}

const round = (value: number, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits;

async function getPipelineStatus() {
  const names = Object.keys(QUERIES) as QueryName[];
  const results = await Promise.all(names.map(name => query(name)));
  const get = (name: QueryName) => results[names.indexOf(name)] ?? null;
  const reachable = results.some(result => result !== null);

  return {
    checkedAt: Date.now(),
    prometheus: reachable ? 'ok' : 'unavailable',
    services: (get('up') ?? []).map(sample => ({ job: sample.labels.job ?? 'unknown', up: sample.value === 1 })).sort((a, b) => a.job.localeCompare(b.job)),
    datasets: (get('dataAge') ?? []).map(sample => ({ dataset: sample.labels.dataset ?? 'unknown', ageSeconds: round(sample.value) })),
    kafka: {
      gatewayConnected: get('gatewayKafka')?.[0]?.value === 1,
      consumerLag: (get('consumerLag') ?? []).map(sample => ({ group: sample.labels.consumergroup ?? 'unknown', lag: round(sample.value) })),
      // 지금 코드가 쓰는 DLQ 토픽만 (예전에 만들었다가 쓰지 않는 토픽은 보여 주지 않음)
      dlq: (get('dlq') ?? []).filter(sample => KNOWN_DLQ_TOPICS.has(sample.labels.topic ?? ''))
        .map(sample => ({ topic: sample.labels.topic ?? 'unknown', messages: round(sample.value) })),
    },
    collectors: {
      yahoo15m: Object.fromEntries((get('yahoo') ?? []).map(sample => [sample.labels.result ?? 'unknown', round(sample.value)])),
      krxLastSuccessAge: (get('krxAge') ?? []).map(sample => ({ endpoint: sample.labels.endpoint ?? 'unknown', seconds: round(sample.value) })),
      dartLastSuccessAge: get('dartAge')?.[0] ? round(get('dartAge')![0]!.value) : null,
    },
    browser: { wsConnections: get('wsConnections')?.[0] ? round(get('wsConnections')![0]!.value) : null },
    db: {
      sizeBytes: get('dbSize')?.[0] ? round(get('dbSize')![0]!.value) : null,
      jobs: (get('dbJobFailures') ?? []).map(sample => {
        const job = dbJobName(sample.labels);
        const delay = (get('dbJobDelay') ?? []).find(item => dbJobName(item.labels) === job);
        return { job, failures: round(sample.value), delayRatio: delay ? round(delay.value, 2) : null };
      }).sort((a, b) => a.job.localeCompare(b.job)),
    },
  };
}

// 검증용 자체 점검 (기존 스위치 HISTORY_SELF_CHECK=true일 때만, 기본 끔): 상태 요약을 한 줄 로그로 (서비스 이름·숫자만)
export function startPipelineSelfCheck() {
  if (process.env.HISTORY_SELF_CHECK !== 'true') return;
  setInterval(async () => {
    try {
      const startedAt = Date.now();
      const status = await getPipelineStatus();
      console.log(`[pipeline-check] ${JSON.stringify({ ms: Date.now() - startedAt, ...status })}`);
    } catch (error) {
      console.error(`[pipeline-check] failed: ${error instanceof Error ? error.message : 'unexpected_error'}`);
    }
  }, 60_000);
}

export const pipelineController = async (fastify: FastifyInstance) => {
  fastify.get('/api/v1/system/pipeline', async (_request, reply) => {
    const startedAt = Date.now();
    try {
      const cached = await cache.readJson('system:pipeline');
      if (cached) {
        statusDuration.observe({ result: 'cache_hit' }, Date.now() - startedAt);
        return cached;
      }
      const payload = await getPipelineStatus();
      cache.writeJson('system:pipeline', payload, CACHE_TTL_S);
      statusDuration.observe({ result: payload.prometheus === 'ok' ? 'cache_miss' : 'unavailable' }, Date.now() - startedAt);
      return payload;
    } catch (err) {
      statusDuration.observe({ result: 'error' }, Date.now() - startedAt);
      console.error(`Error building pipeline status: ${err instanceof Error ? err.message : 'unexpected_error'}`);
      return reply.code(500).send({ error: 'Failed to build pipeline status' });
    }
  });
};
