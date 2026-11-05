import { producer, TOPICS, ensureTopics } from '../kafka.js';
import { fetchJson, HttpJsonError, safeLogList, safeLogText } from '../http-json.js';
import { Counter, Gauge, metricsConfig, startMetricsLog, startMetricsServer } from '../metrics.js';
import { registerShutdown } from '../shutdown.js';
import { isoDate, reportRun } from '../ingestion-report.js';
import type { IngestionStatus } from '../../shared/ingestion-runs.js';
import { dailyCloseTime, dailyValues, readDataGoKrResponse, type MarketFlow, type MarketFlowDataset } from '../../shared/market-flows.js';
import { nextCollectDelay } from './collect-schedule.js';
import { setWallClockTimeout, type WallClockTimer } from '../wall-clock-timer.js';

// 증시 자금 흐름 일별 통계 수집기 (docs/Task_ORDER.md 11단계 B′ T-95, D-45, D-65, D-76, D-77)
// 공공데이터포털 "금융투자협회 종합통계"의 증시자금추이·신용공여잔고추이를 받아 Kafka `market-flows`로 보낸다.
// - 화면은 최근 1개월만 보여 준다(D-77). 그래서 주기마다 오퍼레이션당 1번, 최근 35일을 한꺼번에 요청한다(약 25 영업일, 응답 수 KB).
//   과거 채우기가 따로 없어서 다시 시작해도 대량 호출이 생기지 않는다(SEC-014와 같은 목적).
// - 값은 영업일 기준 2 ~ 3일 늦게 공개된다(B-47 관찰). 그래서 6시간마다 확인하고, 값이 바뀐 날짜만 보낸다.
// - 키 오류·호출 한도 같은 결과 코드면 24시간 멈춘다. 그 밖의 실패는 첫 번째만 30분 뒤 다시 시도하고, 이어서 실패하면 2배씩 늦춘다(최대 24시간, T-137).
// - 키를 가진 컨테이너는 이것 하나뿐이다. 접속 대상은 아래 고정 주소 하나(apis.data.go.kr, D-45 승인)이고 환경변수로 바꿀 수 없다.
// - 키는 요청 주소(쿼리)에 들어가므로 주소·키·오류 원문을 로그에 남기지 않는다. 응답에서 온 문자열은 safeLogText로 정리해서 남긴다.

const BASE_URL = 'https://apis.data.go.kr/1160100/service/GetKofiaStatisticsInfoService';
const OPERATIONS: { dataset: MarketFlowDataset; operation: string }[] = [
  { dataset: 'capital', operation: 'getSecuritiesMarketTotalCapitalInfo' }, // 증시자금추이 (2026-10-28 실제 응답으로 확인)
  { dataset: 'credit', operation: 'getGrantingOfCreditBalanceInfo' },        // 신용공여잔고추이
];
const readIntEnv = (name: string, fallback: number) => Number.parseInt(process.env[name] ?? '', 10) || fallback;
const POLLING_INTERVAL_MS = readIntEnv('MARKET_STATS_POLLING_INTERVAL_MS', 6 * 3600_000);
const MAX_DELAY_MS = 24 * 3600_000;
const WINDOW_DAYS = 35;
const NUM_OF_ROWS = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const KEY_PATTERN = /^[A-Za-z0-9%+/=._~-]{10,512}$/;
// 키·권한·한도 관련 결과 코드: 계속 호출해도 같은 결과라 하루 멈춘다 (공공데이터포털 공통 오류 코드)
const PAUSE_CODES = new Set(['20', '22', '30', '31', '32']);

const fetchTotal = new Counter('kospi_market_stats_fetch_total', 'KOFIA statistics fetches by operation and result (ok / error / result_code)');
const sentTotal = new Counter('kospi_market_stats_days_sent_total', 'Dataset-days sent to Kafka by dataset');
// 수집 중단 알림용 (KRX·DART 수집기와 같은 방식): 오퍼레이션별 마지막 성공 시각
const lastSuccessAt = new Gauge('kospi_market_stats_last_success_timestamp_seconds', 'Unix time of the last successful KOFIA statistics fetch, by operation');

const lastSent = new Map<string, string>();
let stopping = false;
let timer: WallClockTimer | undefined;
let consecutiveFailures = 0;
// 검증용 (기본 끔, BENCHMARK B-51): 첫 주기를 요청 없이 일시 실패로 처리해서 재시도 일정(T-137)을 실제 실행으로 확인한다
let failFirstCycle = process.env.MARKET_STATS_TEST_FAIL_FIRST === 'true';

const seoulDay = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');

// 포털은 Encoding 키(이미 % 인코딩됨)와 Decoding 키를 둘 다 준다. %가 있으면 그대로, 없으면 인코딩해서 넣는다
function requestUrl(operation: string, key: string, nowMs: number) {
  const params = new URLSearchParams({
    numOfRows: String(NUM_OF_ROWS),
    pageNo: '1',
    resultType: 'json',
    beginBasDt: seoulDay(nowMs - WINDOW_DAYS * 86_400_000),
    endBasDt: seoulDay(nowMs),
  });
  const encodedKey = key.includes('%') ? key : encodeURIComponent(key);
  return `${BASE_URL}/${operation}?serviceKey=${encodedKey}&${params.toString()}`;
}

// 한 오퍼레이션을 받아 바뀐 날짜만 보낸다. 'ok' | 'pause'(하루 멈춤) | 'error'
async function collect(dataset: MarketFlowDataset, operation: string, key: string): Promise<'ok' | 'pause' | 'error'> {
  const startedAt = Date.now();
  // 적재 실행 기록 (T-118). 기간은 요청한 최근 35일이다
  const report = (received: number, sent: number, status: IngestionStatus, errorKind: string | null, sourceTotal: number | null = null, dropped: Record<string, number> = {}) => reportRun(producer, {
    source: 'kofia', endpoint: operation, startedAt,
    targetFrom: isoDate(seoulDay(startedAt - WINDOW_DAYS * 86_400_000)), targetTo: isoDate(seoulDay(startedAt)),
    received, sent, status, errorKind, sourceTotal, covered: sourceTotal === null ? null : received, dropped,
  });
  let body: unknown;
  try {
    const response = await fetchJson(requestUrl(operation, key, startedAt), { timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES });
    if (!response.ok) {
      fetchTotal.inc({ operation, result: 'error' });
      console.warn(`[market-stats] ${operation}: HTTP ${response.status}`);
      await report(0, 0, 'error', `http_${response.status}`);
      return response.status === 401 || response.status === 403 || response.status === 429 ? 'pause' : 'error';
    }
    body = response.body;
  } catch (error) {
    fetchTotal.inc({ operation, result: 'error' });
    const kind = error instanceof HttpJsonError ? `${error.message}${error.status ? ` status=${error.status}` : ''}` : 'unexpected_error';
    console.warn(`[market-stats] ${operation}: request failed (${kind})`);
    await report(0, 0, 'error', error instanceof HttpJsonError ? error.message : 'unexpected_error');
    return 'error';
  }

  const { resultCode, resultMsg, totalCount, rows } = readDataGoKrResponse(body);
  if (resultCode !== '00') {
    fetchTotal.inc({ operation, result: 'result_code' });
    console.warn(`[market-stats] ${operation}: resultCode=${safeLogText(resultCode ?? 'none', 10)} msg=${safeLogText(resultMsg ?? '', 60)}`);
    await report(0, 0, 'error', 'result_code');
    return resultCode !== null && PAUSE_CODES.has(resultCode) ? 'pause' : 'error';
  }
  fetchTotal.inc({ operation, result: 'ok' });
  lastSuccessAt.set({ operation }, Math.floor(Date.now() / 1000));
  if (Number.isFinite(totalCount) && totalCount > rows.length) {
    console.warn(`[market-stats] ${operation}: received ${rows.length} of ${totalCount} rows (window larger than one page)`);
  }

  const { days, problems, skippedFields, rowsWithoutDate } = dailyValues(rows);
  for (const problem of problems) console.warn(`[market-stats] ${operation} ${problem.basDt}: not stored (${problem.reason})`);
  const changed = days.filter(day => lastSent.get(`${dataset}|${day.basDt}`) !== JSON.stringify(day.values));
  if (changed.length > 0) {
    const producedAt = Date.now();
    await producer.send({
      topic: TOPICS.marketFlows,
      messages: changed.map(day => {
        const flow: MarketFlow = { time: dailyCloseTime(day.basDt), dataset, values: day.values, collectedAt: startedAt, producedAt };
        return { key: dataset, value: JSON.stringify(flow) };
      }),
    });
    for (const day of changed) lastSent.set(`${dataset}|${day.basDt}`, JSON.stringify(day.values));
    sentTotal.inc({ dataset }, changed.length);
  }
  // 응답 필드 이름(값 제외)과 건수만 남긴다
  console.log(`[market-stats] ${operation}: ${rows.length} rows, ${days.length} days (latest ${days.at(-1)?.basDt ?? 'none'}), sent ${changed.length} changed` +
    `${skippedFields || rowsWithoutDate ? `, skipped fields ${skippedFields}, rows without date ${rowsWithoutDate}` : ''}` +
    `${rows[0] && changed.length > 0 ? ` · fields ${safeLogList(Object.keys(rows[0]), 60)}` : ''}`);
  await report(rows.length, changed.length, rows.length > 0 ? 'ok' : 'empty', null, Number.isFinite(totalCount) ? totalCount : null, { rejected_day: problems.length, row_without_date: rowsWithoutDate });
  return 'ok';
}

async function loop(key: string) {
  if (stopping) return;
  const results: ('ok' | 'pause' | 'error')[] = [];
  if (failFirstCycle) {
    failFirstCycle = false;
    console.warn('MARKET_STATS_TEST_FAIL_FIRST=true: first cycle treated as a transient failure, no request sent (verification only).');
    results.push(...OPERATIONS.map(() => 'error' as const));
  } else {
    for (const { dataset, operation } of OPERATIONS) {
      if (stopping) return;
      results.push(await collect(dataset, operation, key));
    }
  }
  // 다음 주기: 하루 멈춤 / 첫 일시 실패는 30분 뒤 다시 / 그 뒤는 2배씩 (T-137)
  const previousFailures = consecutiveFailures;
  const next = nextCollectDelay(results, consecutiveFailures, POLLING_INTERVAL_MS, MAX_DELAY_MS);
  consecutiveFailures = next.failures;
  if (results.includes('pause')) console.warn(`[market-stats] key, permission or quota problem: pausing for ${MAX_DELAY_MS / 3600_000}h`);
  else if (results.includes('error')) console.warn(`[market-stats] retrying in ${Math.round(next.delayMs / 60_000)}m (consecutive failures: ${next.failures})`);
  else if (previousFailures > 0) console.log(`[market-stats] recovered after ${previousFailures} failed cycle(s); next in ${Math.round(next.delayMs / 3600_000)}h`);
  if (!stopping) timer = setWallClockTimeout(() => void loop(key), next.delayMs);
}

async function main() {
  console.log('Market stats collector starting...');
  startMetricsServer(metricsConfig.port);
  startMetricsLog('market-stats-collector', metricsConfig.logIntervalMs);
  const key = (process.env.DATA_GO_KR_SERVICE_KEY ?? '').trim();
  if (!key) {
    console.warn('[market-stats] DATA_GO_KR_SERVICE_KEY is not configured. Collection is idle.');
    registerShutdown('market-stats-collector', []);
    return;
  }
  // 키 형식만 확인한다(값은 남기지 않음). 공백·줄바꿈·주소 구분 문자가 섞이면 요청 주소가 바뀔 수 있어 보내지 않는다
  if (!KEY_PATTERN.test(key) || key.includes('&') || key.includes('?')) {
    console.warn('[market-stats] DATA_GO_KR_SERVICE_KEY has an unexpected format. Collection is idle.');
    registerShutdown('market-stats-collector', []);
    return;
  }

  await producer.connect();
  await ensureTopics();
  registerShutdown('market-stats-collector', [
    { name: 'poll loop', run: () => { stopping = true; timer?.cancel(); } },
    { name: 'kafka producer', run: () => producer.disconnect() },
  ]);
  console.log(`[market-stats] last ${WINDOW_DAYS} days, ${OPERATIONS.length} requests every ${POLLING_INTERVAL_MS / 3600_000}h.`);
  void loop(key);
}

// 시작 실패(Kafka 연결 등)만 종료 코드 1. 외부 호출 전이라 다시 띄워져도 호출이 반복되지 않는다
main().catch(error => {
  console.error(`Market stats collector failed to start: ${error instanceof Error ? error.message : 'unexpected_error'}`);
  process.exit(1);
});
