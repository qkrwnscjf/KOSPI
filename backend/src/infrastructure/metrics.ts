import { createServer } from 'node:http';
import { readIntSetting } from './int-setting.js';

// Prometheus 텍스트 형식(v0.0.4)으로 메트릭을 노출하는 최소 구현.
// 새 의존성(prom-client)을 추가하지 않기 위해 직접 구현했다 (docs/Task_ORDER.md D-09).
// 라벨에는 source / category / result 같은 고정 값만 넣는다. 비밀값이나 접속 정보를 넣지 않는다.

type Labels = Record<string, string>;

interface Metric {
  render(): string;
}

interface SampleSummary {
  count: number;
  p50_ms?: number;
  p95_ms?: number;
  max_ms?: number;
}

// 정수 설정은 한 함수로 읽는다(QA-39 / T-225). 로그 주기만 0(끔)을 허용한다
export const metricsConfig = {
  // 컨테이너 내부 전용 포트. docker-compose에서 호스트로 공개하지 않는다.
  port: readIntSetting('METRICS_PORT', 9464),
  // 지연 요약 로그 주기. 0이면 로그와 샘플 수집을 모두 끈다.
  logIntervalMs: readIntSetting('METRICS_LOG_INTERVAL_MS', 60000, { min: 0 }),
};

const LATENCY_BUCKETS_SECONDS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900, 3600, 14400, 86400,
];

const registry: Metric[] = [];
const latencies: Latency[] = [];
const counters: Counter[] = [];
const gauges: Gauge[] = [];

// 요약 로그가 켜져 있을 때만 원본 샘플을 모은다 (꺼져 있으면 메모리가 늘지 않게).
let collectSamples = false;

const escapeLabelValue = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

const formatLabels = (labels: Labels, extra: Labels = {}) => {
  const entries = Object.entries({ ...labels, ...extra });
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',')}}`;
};

const labelKey = (labels: Labels) =>
  Object.keys(labels).sort().map(key => `${key}=${labels[key]}`).join(',');

const percentile = (sorted: number[], ratio: number) =>
  sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)] ?? 0;

const summarize = (samples: number[]): SampleSummary => {
  if (samples.length === 0) return { count: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50_ms: Math.round(percentile(sorted, 0.5)),
    p95_ms: Math.round(percentile(sorted, 0.95)),
    max_ms: Math.round(sorted[sorted.length - 1] ?? 0),
  };
};

export class Counter implements Metric {
  private readonly name: string;
  private readonly help: string;
  private readonly series = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
    registry.push(this);
    counters.push(this);
  }

  inc(labels: Labels = {}, amount = 1) {
    const key = labelKey(labels);
    const entry = this.series.get(key);
    if (entry) {
      entry.value += amount;
    } else {
      this.series.set(key, { labels, value: amount });
    }
  }

  snapshot() {
    const result: Record<string, number> = {};
    for (const { labels, value } of this.series.values()) {
      result[`${this.name}${formatLabels(labels)}`] = value;
    }
    return result;
  }

  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

export class Gauge implements Metric {
  private readonly name: string;
  private readonly help: string;
  private readonly series = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
    registry.push(this);
    gauges.push(this);
  }

  set(labels: Labels, value: number) {
    this.series.set(labelKey(labels), { labels, value });
  }

  inc(labels: Labels = {}, amount = 1) {
    const key = labelKey(labels);
    const entry = this.series.get(key);
    this.series.set(key, { labels, value: (entry?.value ?? 0) + amount });
  }

  dec(labels: Labels = {}, amount = 1) {
    this.inc(labels, -amount);
  }

  snapshot() {
    const result: Record<string, number> = {};
    for (const { labels, value } of this.series.values()) {
      result[`${this.name}${formatLabels(labels)}`] = value;
    }
    return result;
  }

  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

interface LatencySeries {
  labels: Labels;
  bucketCounts: number[];
  sum: number;
  count: number;
  samples: number[];
}

// 히스토그램(Prometheus용, 초 단위) + 요약 로그용 샘플(ms 단위)
export class Latency implements Metric {
  private readonly name: string;
  private readonly help: string;
  private readonly series = new Map<string, LatencySeries>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
    registry.push(this);
    latencies.push(this);
  }

  observe(labels: Labels, durationMs: number) {
    if (!Number.isFinite(durationMs)) return;

    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, bucketCounts: LATENCY_BUCKETS_SECONDS.map(() => 0), sum: 0, count: 0, samples: [] };
      this.series.set(key, entry);
    }

    const seconds = durationMs / 1000;
    const index = LATENCY_BUCKETS_SECONDS.findIndex(bound => seconds <= bound);
    if (index >= 0) {
      entry.bucketCounts[index] = (entry.bucketCounts[index] ?? 0) + 1;
    }
    entry.sum += seconds;
    entry.count += 1;
    if (collectSamples) {
      entry.samples.push(durationMs);
    }
  }

  drainSummaries() {
    const result: Record<string, SampleSummary> = {};
    for (const entry of this.series.values()) {
      result[`${this.name}${formatLabels(entry.labels)}`] = summarize(entry.samples);
      entry.samples = [];
    }
    return result;
  }

  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const entry of this.series.values()) {
      let cumulative = 0;
      LATENCY_BUCKETS_SECONDS.forEach((bound, index) => {
        cumulative += entry.bucketCounts[index] ?? 0;
        lines.push(`${this.name}_bucket${formatLabels(entry.labels, { le: String(bound) })} ${cumulative}`);
      });
      lines.push(`${this.name}_bucket${formatLabels(entry.labels, { le: '+Inf' })} ${entry.count}`);
      lines.push(`${this.name}_sum${formatLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${formatLabels(entry.labels)} ${entry.count}`);
    }
    return lines.join('\n');
  }
}

// 프로세스 메모리 (plan.md QA-36, T-220): compose 메모리 상한을 실측으로 정하고 넘지 않는지 보기 위함. 수집·로그 때 갱신한다
const residentMemory = new Gauge('kospi_process_resident_memory_bytes', 'Resident memory of this Node process in bytes (T-220)');
const refreshProcessMetrics = () => residentMemory.set({}, process.memoryUsage().rss);

export const renderMetrics = () => {
  refreshProcessMetrics();
  return `${registry.map(metric => metric.render()).join('\n')}\n`;
};

// /health 결과를 만드는 함수 (T-152). health.ts가 불러와지면 자기 평가 함수로 바꾼다(서로 import하지 않도록 이쪽은 받기만 함).
// 점검이 등록되지 않은 프로세스는 응답한다는 것만으로 정상이다
type HealthEvaluator = () => Promise<{ ok: boolean; checks: Record<string, boolean> }>;
let healthEvaluator: HealthEvaluator = async () => ({ ok: true, checks: {} });
export const setHealthEvaluator = (evaluator: HealthEvaluator) => { healthEvaluator = evaluator; };

export const startMetricsServer = (port: number) => {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/metrics') {
      response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      response.end(renderMetrics());
      return;
    }
    // 서비스별 실제 상태 (T-152). 점검 이름과 참/거짓만 돌려준다. 내부 전용 포트라 호스트에 공개되지 않는다
    if (request.method === 'GET' && request.url === '/health') {
      void healthEvaluator().then(report => {
        response.writeHead(report.ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ status: report.ok ? 'ok' : 'fail', checks: report.checks }));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });

  server.on('error', err => {
    console.error('Metrics server error:', err.message);
  });
  // 컨테이너 안에서는 Prometheus 컨테이너가 접근해야 하므로 0.0.0.0에 바인딩한다.
  // 호스트 공개 여부는 docker-compose의 ports가 결정하며, 이 포트는 공개하지 않는다.
  server.listen(port, '0.0.0.0');
  // 컨테이너 실행 사용자 (plan.md 5장 S-4, SEC-006, T-36): root(0)가 아닌지 로그로 확인한다. 번호만 남긴다
  console.log(`Process user: uid ${process.getuid?.() ?? 'unknown'}`);
  return server;
};

// 에이전트가 docker logs로 수치를 읽을 수 있도록 주기적으로 한 줄 JSON 요약을 출력한다.
export const startMetricsLog = (component: string, intervalMs: number) => {
  if (intervalMs <= 0) return;
  collectSamples = true;

  setInterval(() => {
    refreshProcessMetrics();
    const summary = {
      component,
      window_s: intervalMs / 1000,
      latency: Object.assign({}, ...latencies.map(latency => latency.drainSummaries())),
      totals: Object.assign({}, ...counters.map(counter => counter.snapshot()), ...gauges.map(gauge => gauge.snapshot())),
    };
    console.log(`[metrics] ${JSON.stringify(summary)}`);
  }, intervalMs);
};
