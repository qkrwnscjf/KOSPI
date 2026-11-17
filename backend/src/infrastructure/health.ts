import type { Consumer, Producer } from 'kafkajs';
import { Gauge, setHealthEvaluator } from './metrics.js';

// 서비스별 실제 상태 점검 (docs/Task_ORDER.md T-152, BENCHMARK B-75)
// 프로세스가 살아 있는지만이 아니라, 그 서비스가 일을 하는 데 필요한 연결(Kafka·DB)과 루프가 동작하는지 본다.
// 메트릭 서버(내부 전용 포트)의 GET /health가 이 결과로 200/503을 돌려주고, docker-compose healthcheck가 이를 쓴다.
// 결과에는 점검 이름과 참/거짓만 넣는다. 주소·오류 원문·비밀값은 넣지 않는다.

export type HealthCheck = () => boolean | Promise<boolean>;

export interface HealthReport {
  ok: boolean;
  checks: Record<string, boolean>;
}

const readIntEnv = (name: string, fallback: number) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isNaN(value) || value <= 0 ? fallback : value;
};

// 점검 하나가 이 시간 안에 끝나지 않으면 실패로 본다(DB가 응답하지 않는 경우 등). healthcheck 제한 시간(5초)보다 짧게 둔다
const CHECK_TIMEOUT_MS = readIntEnv('HEALTH_CHECK_TIMEOUT_MS', 2000);
// kafkajs 컨슈머의 기본 세션 제한(30초)을 넘겨 하트비트·fetch가 없으면 브로커도 그 멤버를 그룹에서 뺀다. 그 2배를 기준으로 둔다
export const CONSUMER_SILENCE_LIMIT_MS = readIntEnv('HEALTH_CONSUMER_SILENCE_MS', 2 * 30_000);

const checks = new Map<string, HealthCheck>();
const healthStatus = new Gauge('kospi_health_status', 'Result of each health check at the last /health evaluation (1 ok, 0 failing)');
let lastSummary: string | undefined;

export function registerHealthCheck(name: string, check: HealthCheck) {
  checks.set(name, check);
}

async function runCheck(check: HealthCheck, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(check),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// 모든 점검을 함께 실행한다. 하나라도 거짓이면 ok가 아니다. 상태가 바뀔 때만 한 줄 로그를 남긴다
export async function evaluateHealth(timeoutMs = CHECK_TIMEOUT_MS): Promise<HealthReport> {
  const entries = [...checks.entries()];
  const results = await Promise.all(entries.map(([, check]) => runCheck(check, timeoutMs)));
  const report: HealthReport = {
    ok: results.every(Boolean),
    checks: Object.fromEntries(entries.map(([name], index) => [name, results[index] ?? false])),
  };
  for (const [name, ok] of Object.entries(report.checks)) healthStatus.set({ check: name }, ok ? 1 : 0);
  const summary = JSON.stringify({ status: report.ok ? 'ok' : 'fail', checks: report.checks });
  if (summary !== lastSummary) {
    console.log(`[health] ${summary}`);
    lastSummary = summary;
  }
  return report;
}

setHealthEvaluator(() => evaluateHealth());

// 주기적으로 도는 루프가 멈추지 않았는지: 마지막 beat()가 maxAgeMs 안이면 정상. 등록한 시각을 첫 beat로 본다(기동 직후 여유)
export function registerHeartbeat(name: string, maxAgeMs: number, now: () => number = Date.now) {
  let lastBeat = now();
  registerHealthCheck(name, () => now() - lastBeat <= maxAgeMs);
  return { beat: () => { lastBeat = now(); } };
}

// Kafka 컨슈머: 그룹에 들어가 있고(GROUP_JOIN 이후 CRASH·STOP·DISCONNECT 없음), 최근 silenceMs 안에 하트비트나 fetch가 있었는지.
// kafkajs가 스스로 다시 시작하는 중단(restart: true)이면 다시 그룹에 들어올 때 정상으로 돌아온다
export function trackConsumer(name: string, consumer: Consumer, silenceMs = CONSUMER_SILENCE_LIMIT_MS, now: () => number = Date.now) {
  let joined = false;
  let lastActivity = 0;
  const active = () => { lastActivity = now(); };
  consumer.on(consumer.events.GROUP_JOIN, () => { joined = true; active(); });
  consumer.on(consumer.events.HEARTBEAT, active);
  consumer.on(consumer.events.FETCH_START, active);
  const left = () => { joined = false; };
  consumer.on(consumer.events.CRASH, left);
  consumer.on(consumer.events.STOP, left);
  consumer.on(consumer.events.DISCONNECT, left);
  registerHealthCheck(name, () => joined && now() - lastActivity <= silenceMs);
}

// Kafka 프로듀서: 연결되어 있고 마지막 전송이 실패하지 않았는지. 쉬고 있는 프로듀서는 보낼 때 kafkajs가 다시 연결하므로
// 전송 결과로 판단한다(평소에는 점검 때문에 브로커에 요청을 더 보내지 않음). 전송 실패 뒤 다음 전송이 성공하면 정상으로 돌아온다.
// 30분 ~ 6시간마다 보내는 수집기는 다음 전송까지 실패 상태가 남으므로, 실패 상태일 때만 probe(브로커 확인)를 한 번에 하나씩 돌려
// 성공하면 정상으로 되돌린다. CONNECT 이벤트를 받아야 하므로 producer.connect() 전에 부른다
export function trackProducer(name: string, producer: Producer, probe: () => Promise<void>) {
  let connected = false;
  let lastSendFailed = false;
  let probing: Promise<void> | undefined;
  const recheck = () => {
    probing ??= probe()
      .then(() => { lastSendFailed = false; })
      .catch(() => undefined)
      .finally(() => { probing = undefined; });
  };
  producer.on(producer.events.CONNECT, () => { connected = true; });
  producer.on(producer.events.DISCONNECT, () => { connected = false; });
  const recordResult = async <T>(run: () => Promise<T>) => {
    try {
      const result = await run();
      lastSendFailed = false;
      return result;
    } catch (error) {
      lastSendFailed = true;
      throw error;
    }
  };
  const send = producer.send.bind(producer);
  const sendBatch = producer.sendBatch.bind(producer);
  producer.send = message => recordResult(() => send(message));
  producer.sendBatch = batch => recordResult(() => sendBatch(batch));
  registerHealthCheck(name, () => {
    if (connected && lastSendFailed) recheck();
    return connected && !lastSendFailed;
  });
}
