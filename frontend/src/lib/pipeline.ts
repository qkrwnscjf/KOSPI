// 파이프라인 상태 표시 (docs/Task_ORDER.md T-112)
// 테스트할 수 있도록 React와 분리한 순수 함수다. 다른 모듈을 import하지 않는다.

export const DATASET_LABELS: Record<string, string> = {
  market_ticks: '실시간 시세 (원본 tick)',
  index_daily: 'KRX·Yahoo 일별 지수',
  market_breadth: '시장 폭·거래대금',
  disclosures: 'DART 공시',
  stock_rankings: '종목 순위',
  // 빠져 있던 라벨 (plan.md QA-32 / P4-2, T-215): db-sink가 신선도를 기록하는 데이터셋 6개 모두
  market_flows: '증시 자금 흐름 (일별 통계)',
}

// Prometheus 수집 대상 이름(monitoring/prometheus.yml job_name) 7개 모두
export const SERVICE_LABELS: Record<string, string> = {
  worker: '시세 수집기 (Yahoo)',
  backend: 'API · 실시간 전송',
  'db-sink': 'DB 적재',
  'krx-collector': 'KRX 수집기',
  'disclosure-collector': 'DART 수집기',
  'market-stats-collector': '증시 자금 흐름 수집기',
  'kafka-exporter': 'Kafka 지표',
}

export interface PipelineStatus {
  checkedAt: number | null
  prometheus: 'ok' | 'unavailable'
  services: { job: string; up: boolean }[]
  datasets: { dataset: string; ageSeconds: number }[]
  gatewayConnected: boolean
  consumerLag: { group: string; lag: number }[]
  dlq: { topic: string; messages: number }[]
  yahoo15m: Record<string, number>
  krxLastSuccessAge: { endpoint: string; seconds: number }[]
  dartLastSuccessAge: number | null
  wsConnections: number | null
  dbSizeBytes: number | null
  dbJobs: { job: string; failures: number; delayRatio: number | null }[]
}

const obj = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const str = (value: unknown) => (typeof value === 'string' ? value : null)
// 배열의 각 항목에서 필요한 필드만 꺼낸다. 맞지 않는 항목은 버린다
function list<T>(value: unknown, pick: (item: Record<string, unknown>) => T | null): T[] {
  return Array.isArray(value) ? value.flatMap(item => { const picked = pick(obj(item)); return picked === null ? [] : [picked] }) : []
}

export function toPipelineStatus(raw: unknown): PipelineStatus | null {
  const body = obj(raw)
  const prometheus = body.prometheus
  if (prometheus !== 'ok' && prometheus !== 'unavailable') return null
  const kafka = obj(body.kafka)
  const collectors = obj(body.collectors)
  const db = obj(body.db)
  const yahoo = obj(collectors.yahoo15m)
  return {
    checkedAt: num(body.checkedAt),
    prometheus,
    services: list(body.services, item => (str(item.job) !== null && typeof item.up === 'boolean' ? { job: str(item.job)!, up: item.up } : null)),
    datasets: list(body.datasets, item => (str(item.dataset) !== null && num(item.ageSeconds) !== null ? { dataset: str(item.dataset)!, ageSeconds: num(item.ageSeconds)! } : null)),
    gatewayConnected: kafka.gatewayConnected === true,
    consumerLag: list(kafka.consumerLag, item => (str(item.group) !== null && num(item.lag) !== null ? { group: str(item.group)!, lag: num(item.lag)! } : null)),
    dlq: list(kafka.dlq, item => (str(item.topic) !== null && num(item.messages) !== null ? { topic: str(item.topic)!, messages: num(item.messages)! } : null)),
    yahoo15m: Object.fromEntries(Object.entries(yahoo).flatMap(([key, value]) => (num(value) === null ? [] : [[key, num(value)!]]))),
    krxLastSuccessAge: list(collectors.krxLastSuccessAge, item => (str(item.endpoint) !== null && num(item.seconds) !== null ? { endpoint: str(item.endpoint)!, seconds: num(item.seconds)! } : null)),
    dartLastSuccessAge: num(collectors.dartLastSuccessAge),
    wsConnections: num(obj(body.browser).wsConnections),
    dbSizeBytes: num(db.sizeBytes),
    dbJobs: list(db.jobs, item => (str(item.job) !== null && num(item.failures) !== null ? { job: str(item.job)!, failures: num(item.failures)!, delayRatio: num(item.delayRatio) } : null)),
  }
}

// 초 → "방금" / "12분" / "3.5시간" / "2.1일"
export function formatAge(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  if (seconds < 60) return '방금'
  if (seconds < 3600) return `${Math.round(seconds / 60)}분`
  if (seconds < 86_400 * 2) return `${(seconds / 3600).toFixed(1)}시간`
  return `${(seconds / 86_400).toFixed(1)}일`
}

// 바이트 → "28.1MB"
export function formatBytes(bytes: number | null) {
  if (bytes === null || !Number.isFinite(bytes)) return '—'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}GB`
  return `${(bytes / 1024 ** 2).toFixed(1)}MB`
}

// DB 작업 지연 배수: 3을 넘으면 알림 기준(Grafana 'DB 집계·보관 작업 멈춤')과 같음
export const jobState = (failures: number, delayRatio: number | null) =>
  delayRatio !== null && delayRatio > 3 ? 'stalled' : failures > 0 ? 'failed_before' : 'ok'
