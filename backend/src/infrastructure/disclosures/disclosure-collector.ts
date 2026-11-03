import { producer, TOPICS, ensureTopics } from '../kafka.js';
import { Counter, Gauge, Latency, metricsConfig, startMetricsLog, startMetricsServer } from '../metrics.js';
import { registerShutdown } from '../shutdown.js';
import { DISCLOSURE_SCOPE, isTargetStock, type Disclosure } from '../../shared/disclosures.js';
import { DART_KEY_ERRORS, DART_STATUS, DartApiError, DartClient, readDartConfig } from './dart-client.js';
import { backfillRanges, DETAIL_ENDPOINTS, mapListItem, sumAmountFields, toDartDate, type DisclosureBase } from './dart-disclosures.js';
import { safeLogList } from '../http-json.js';
import { fetchDisclosureCoverage } from '../backend-coverage.js';

// DART 공시 수집기 (docs/Task_ORDER.md 12단계 T-74, D-56 ~ D-59)
// - 최신 공시 목록 전체(유가증권)를 주기적으로 받아 대상 기업만 남기고, 접수번호로 중복을 거른다 (D-59 ①②).
// - 희석·주주환원 공시는 주요사항보고서 API로 금액을 받는다. 금액이 없으면 null (D-59 ④).
// - 시작할 때 최근 DISCLOSURE_BACKFILL_DAYS일을 한 번 채운다(화면 실시간 전송은 하지 않음, live=false).
// - DART 키를 가진 컨테이너는 이 수집기 하나뿐이다. 키가 없으면 접속하지 않고 대기한다.
// - 요청 URL에 키가 들어가므로 URL을 어디에도 남기지 않는다 (dart-client.ts, D-59 ⑥).

const readIntEnv = (name: string, fallback: number) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isNaN(value) ? fallback : value;
};
const ACTIVE_INTERVAL_MS = readIntEnv('DISCLOSURE_POLLING_INTERVAL_MS', 60_000);
const IDLE_INTERVAL_MS = readIntEnv('DISCLOSURE_IDLE_INTERVAL_MS', 10 * 60_000);
// 1년(화면의 "1년" 기간과 DB 보관 1년에 맞춤, T-79). 이미 저장된 기간은 건너뛴다 (SEC-014)
const BACKFILL_DAYS = Math.min(readIntEnv('DISCLOSURE_BACKFILL_DAYS', 365), 365);
const PAGE_COUNT = 100;
const MAX_LIVE_PAGES = 5;                  // 한 주기에 최대 500건. 그 이상 밀리면 다음 주기에 이어서 받는다
const MAX_BACKFILL_PAGES_PER_WINDOW = 400; // 과거 채우기 상한 (호출 수 보호, 3개월 유가증권 공시는 수백 쪽 이하로 추정)
const SEARCH_WINDOW_DAYS = 89;             // 회사 지정 없이 검색하면 기간이 3개월로 제한된다
const REQUEST_GAP_MS = 150;
const KEY_ERROR_RETRY_MS = 60 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

const fetchTotal = new Counter('kospi_disclosure_fetch_total', 'DART requests by endpoint kind and result (ok / no_data / error)');
const fetchDuration = new Latency('kospi_disclosure_fetch_duration_seconds', 'DART request duration');
const sentTotal = new Counter('kospi_disclosure_sent_total', 'Disclosures sent to Kafka by group and mode (live / backfill)');
const amountTotal = new Counter('kospi_disclosure_amount_total', 'Capital event amount lookups by result (found / missing / error)');
const requestsToday = new Gauge('kospi_disclosure_requests_today', 'DART requests made since 00:00 KST (daily limit guard)');
const configured = new Gauge('kospi_disclosure_configured', 'Whether the DART API key is configured (1) or not (0)');
const lastSuccessAt = new Gauge('kospi_disclosure_last_success_timestamp_seconds', 'Unix time of the last successful DART list fetch');

const seen = new Set<string>();
const loggedDetailFields = new Set<string>();
let loggedListFields = false;
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let consecutiveFailures = 0;
let requestDay = '';
let requestCount = 0;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const seoulNow = (nowMs = Date.now()) => new Date(nowMs + 9 * 3600_000); // 한국은 서머타임이 없어 +9시간 고정
const seoulDate = (nowMs = Date.now()) => seoulNow(nowMs).toISOString().slice(0, 10);
const daysAgo = (days: number, nowMs = Date.now()) => seoulDate(nowMs - days * 86_400_000);

// 평일 07:00 ~ 19:00(서울)은 공시가 많은 시간이라 짧게, 그 밖에는 길게 조회한다
function isActiveHours(nowMs = Date.now()) {
  const now = seoulNow(nowMs);
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 7 && hour < 19;
}

// 하루 호출 수를 센다 (서울 날짜 기준, 지표로 노출)
function countRequest() {
  const today = seoulDate();
  if (today !== requestDay) {
    requestDay = today;
    requestCount = 0;
  }
  requestCount += 1;
  requestsToday.set({}, requestCount);
}

// 다음 서울 자정 + 10분까지 남은 시간 (호출 한도 초과 시 대기)
function untilNextSeoulDay(nowMs = Date.now()) {
  const now = seoulNow(nowMs);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 10);
  return next - now.getTime();
}

function describeError(error: unknown) {
  if (error instanceof DartApiError) return `${error.message}${error.status ? ` status=${error.status}` : ''}${error.code ? ` code=${error.code}` : ''}`;
  return 'unexpected_error';
}

async function request(client: DartClient, kind: 'list' | 'detail', endpoint: string, params: Record<string, string>) {
  const startedAt = Date.now();
  countRequest();
  try {
    const response = await client.get(endpoint, params);
    fetchDuration.observe({}, Date.now() - startedAt);
    fetchTotal.inc({ kind, result: response.status === DART_STATUS.noData ? 'no_data' : 'ok' });
    return response;
  } catch (error) {
    fetchDuration.observe({}, Date.now() - startedAt);
    fetchTotal.inc({ kind, result: 'error' });
    throw error;
  } finally {
    await sleep(REQUEST_GAP_MS);
  }
}

const listOf = (body: Record<string, unknown>) => (Array.isArray(body.list) ? (body.list as unknown[]) : []);

// 공시 목록 한 쪽. 대상 기업만 남긴다.
async function fetchListPage(client: DartClient, bgnDe: string, endDe: string, pageNo: number) {
  const { body } = await request(client, 'list', 'list.json', {
    bgn_de: bgnDe,
    end_de: endDe,
    corp_cls: 'Y',
    sort: 'date',
    sort_mth: 'desc',
    page_no: String(pageNo),
    page_count: String(PAGE_COUNT),
  });
  const list = listOf(body);
  // 필드 매핑 확정용: 첫 응답의 필드 이름만 한 번 남긴다 (값은 남기지 않음)
  if (!loggedListFields && list[0] && typeof list[0] === 'object') {
    loggedListFields = true;
    console.log(`[dart] list response fields: ${safeLogList(Object.keys(list[0] as object))}`);
  }
  const totalPage = typeof body.total_page === 'number' ? body.total_page : Number(body.total_page ?? 0) || 0;
  const mapped = list.map(mapListItem).filter((item): item is DisclosureBase => item !== null);
  // 이미 본 공시인지는 대상 여부와 상관없이 접수번호로 판단한다 (대상 외 공시만 있는 쪽에서 계속 넘어가지 않게)
  const rceptNos = mapped.map(item => item.rceptNo);
  const items = mapped.filter(item => isTargetStock(item.stockCode));
  return { items, rceptNos, totalPage, rawCount: list.length };
}

// 희석·주주환원 공시의 금액. 같은 회사·같은 API는 한 번에 조회한다 (접수일 범위로 받아 접수번호로 짝지음).
async function resolveAmounts(client: DartClient, items: DisclosureBase[]) {
  const amounts = new Map<string, number | null>();
  const groups = new Map<string, { endpoint: string; fields: readonly string[]; corpCode: string; items: DisclosureBase[] }>();
  for (const item of items) {
    const detail = DETAIL_ENDPOINTS[item.kind];
    if (!detail) continue;
    const key = `${detail.endpoint}|${item.corpCode}`;
    const group = groups.get(key) ?? { ...detail, corpCode: item.corpCode, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (stopping) break;
    const dates = group.items.map(item => toDartDate(item.rceptDate)).sort();
    try {
      const { body } = await request(client, 'detail', group.endpoint, {
        corp_code: group.corpCode,
        bgn_de: dates[0] ?? '',
        end_de: dates[dates.length - 1] ?? '',
      });
      const rows = listOf(body).filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
      if (!loggedDetailFields.has(group.endpoint) && rows[0]) {
        loggedDetailFields.add(group.endpoint);
        console.log(`[dart] ${group.endpoint} response fields: ${safeLogList(Object.keys(rows[0]))}`);
      }
      for (const item of group.items) {
        const row = rows.find(candidate => candidate.rcept_no === item.rceptNo);
        const amount = row ? sumAmountFields(row, group.fields) : null;
        amounts.set(item.rceptNo, amount);
        // 금액이 없는 이유를 나눠 센다: no_row = 주요사항보고서 API에 그 접수번호가 없음, empty_fields = 행은 있으나 금액 필드가 비어 있음
        amountTotal.inc({ result: amount !== null ? 'found' : row ? 'empty_fields' : 'no_row', kind: item.kind });
      }
    } catch (error) {
      // 금액을 못 받아도 공시 자체는 보낸다 (금액 없음). 키·한도 문제는 위로 올려 수집을 멈춘다
      if (error instanceof DartApiError && error.code && (DART_KEY_ERRORS.has(error.code) || error.code === DART_STATUS.rateLimited)) throw error;
      for (const item of group.items) amountTotal.inc({ result: 'error' });
      console.warn(`[dart] ${group.endpoint} amount lookup failed: ${describeError(error)}`);
    }
  }
  return amounts;
}

// 오래된 접수번호부터 Kafka로 보낸다 (화면 목록이 접수 순서대로 쌓이게)
async function send(items: DisclosureBase[], amounts: Map<string, number | null>, live: boolean, collectedAt: number) {
  if (items.length === 0) return;
  const sorted = [...items].sort((a, b) => a.rceptNo.localeCompare(b.rceptNo));
  const producedAt = Date.now();
  const messages = sorted.map(item => {
    const disclosure: Disclosure = { ...item, amount: amounts.get(item.rceptNo) ?? null, live, collectedAt, producedAt };
    return { key: item.rceptNo, value: JSON.stringify(disclosure) };
  });
  // 메시지가 너무 커지지 않게 나눠 보낸다
  for (let index = 0; index < messages.length; index += 200) {
    await producer.send({ topic: TOPICS.disclosures, messages: messages.slice(index, index + 200) });
  }
  for (const item of sorted) sentTotal.inc({ group: item.group, mode: live ? 'live' : 'backfill' });
}

// 주기 조회: 어제 ~ 오늘(서울)의 최신 공시. 이미 본 접수번호가 나오면 그 뒤 쪽은 읽지 않는다.
async function pollOnce(client: DartClient) {
  const collectedAt = Date.now();
  const bgnDe = toDartDate(daysAgo(1));
  const endDe = toDartDate(seoulDate());
  const fresh: DisclosureBase[] = [];
  const pageNos: string[] = [];
  for (let pageNo = 1; pageNo <= MAX_LIVE_PAGES && !stopping; pageNo += 1) {
    const { items, rceptNos, totalPage, rawCount } = await fetchListPage(client, bgnDe, endDe, pageNo);
    fresh.push(...items.filter(item => !seen.has(item.rceptNo)));
    pageNos.push(...rceptNos);
    // 이 쪽에 이미 본 공시가 있거나 마지막 쪽이면 멈춘다 (최신순이라 그 뒤는 모두 본 공시)
    if (rceptNos.some(rceptNo => seen.has(rceptNo)) || rawCount < PAGE_COUNT || pageNo >= totalPage) break;
  }
  lastSuccessAt.set({}, Math.floor(Date.now() / 1000));

  if (fresh.length > 0) {
    const amounts = await resolveAmounts(client, fresh);
    await send(fresh, amounts, true, collectedAt);
    console.log(`[dart] ${fresh.length} new disclosures`);
  }
  // 보낸 뒤에 기억한다 (보내기 전에 실패하면 다음 주기에 다시 시도)
  for (const rceptNo of pageNos) seen.add(rceptNo);

  // 주기 조회 범위(어제 ~ 오늘)보다 오래된 접수번호는 기억할 필요가 없다
  const oldest = toDartDate(daysAgo(2));
  for (const rceptNo of seen) if (rceptNo.slice(0, 8) < oldest) seen.delete(rceptNo);
}

// 시작 시 1회: 최근 BACKFILL_DAYS일 중 아직 저장되지 않은 기간만 (docs/security.md SEC-014).
// 저장 범위는 backend에 묻고, 확인하지 못하면 false를 돌려줘서 다음 주기에 다시 시도한다(재시작이 반복돼도 대량 호출이 생기지 않게).
// 3개월 단위로 나눠 모든 쪽을 받는다.
async function backfill(client: DartClient): Promise<boolean> {
  const stored = await fetchDisclosureCoverage();
  if (!stored) {
    console.warn('[dart] stored range unavailable from backend; backfill postponed to the next cycle');
    return false;
  }
  const targetStart = toDartDate(daysAgo(BACKFILL_DAYS));
  const today = toDartDate(seoulDate());
  const ranges = backfillRanges(targetStart, today, stored.coverage);
  const startedAt = Date.now();
  let total = 0;
  // 3개월 창 목록 (회사 지정 없는 검색의 기간 제한)
  const windows: [string, string][] = [];
  for (const [from, to] of ranges) {
    for (let bgn = from; bgn <= to; bgn = shiftDays(bgn, SEARCH_WINDOW_DAYS + 1)) {
      const end = shiftDays(bgn, SEARCH_WINDOW_DAYS);
      windows.push([bgn, end < to ? end : to]);
    }
  }
  for (const [bgnDe, endDe] of windows) {
    if (stopping) break;
    const items: DisclosureBase[] = [];
    const windowNos: string[] = [];
    for (let pageNo = 1; !stopping; pageNo += 1) {
      if (pageNo > MAX_BACKFILL_PAGES_PER_WINDOW) {
        console.warn(`[dart] backfill page limit (${MAX_BACKFILL_PAGES_PER_WINDOW}) reached for ${bgnDe}-${endDe}; older disclosures in this window are skipped`);
        break;
      }
      const page = await fetchListPage(client, bgnDe, endDe, pageNo);
      items.push(...page.items);
      windowNos.push(...page.rceptNos);
      if (page.rawCount < PAGE_COUNT || pageNo >= page.totalPage) break;
    }
    const amounts = await resolveAmounts(client, items);
    await send(items, amounts, false, startedAt);
    for (const rceptNo of windowNos) seen.add(rceptNo);
    total += items.length;
  }
  const storedText = stored.coverage ? `${stored.coverage.earliest}-${stored.coverage.latest}` : 'none';
  const rangeText = ranges.map(([from, to]) => `${from}-${to}`).join(',');
  console.log(`[dart] backfill done: ${total} disclosures in ${rangeText} (target ${targetStart}, stored ${storedText}, ${DISCLOSURE_SCOPE}) in ${Math.round((Date.now() - startedAt) / 1000)}s, requests ${requestCount}`);
  // 당일 누락 점검(B-26)의 기준: 이 시점까지 받은 오늘 공시 중 가장 늦은 접수번호. 이후 공시는 실시간 조회로 받아야 한다
  liveBaseline = [...seen].filter(rceptNo => rceptNo.startsWith(today)).sort().pop() ?? `${today}000000`;
  return true;
}

const shiftDays = (ymd: string, days: number) =>
  new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))) + days * 86_400_000)
    .toISOString().slice(0, 10).replace(/-/g, '');

// 오류 종류에 따라 다음 시도까지 기다릴 시간
function retryDelay(error: unknown) {
  if (error instanceof DartApiError && error.code === DART_STATUS.rateLimited) return untilNextSeoulDay();
  if (error instanceof DartApiError && error.code && DART_KEY_ERRORS.has(error.code)) return KEY_ERROR_RETRY_MS;
  return Math.min(ACTIVE_INTERVAL_MS * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
}

let backfilled = BACKFILL_DAYS <= 0;

// ── 당일 누락 점검 (docs/BENCHMARK.md B-26 기준 4, 검증용 스위치 DISCLOSURE_SELF_CHECK=true) ──
// DART의 오늘 전체 목록(유가증권)과 수집기가 받아서 보낸 접수번호를 비교한다. 보낸 공시는 DB Sink가 저장한다(B-26 기준 1).
// 로그에는 건수와 빠진 접수번호 예시(공개 번호)만 남긴다.
const SELF_CHECK = process.env.DISCLOSURE_SELF_CHECK === 'true';
const SELF_CHECK_INTERVAL_MS = 30 * 60_000;
let lastCheckAt = 0;
let liveBaseline: string | null = null;

async function fetchDayRceptNos(client: DartClient, day: string) {
  const rceptNos: string[] = [];
  for (let pageNo = 1; pageNo <= 50 && !stopping; pageNo += 1) {
    const page = await fetchListPage(client, day, day, pageNo);
    rceptNos.push(...page.rceptNos);
    if (page.rawCount < PAGE_COUNT || pageNo >= page.totalPage) break;
  }
  return rceptNos;
}

function reportSelfCheck(day: string, source: string[]) {
  const unique = [...new Set(source)];
  const missing = unique.filter(rceptNo => !seen.has(rceptNo));
  // 시작 후 실시간 조회로만 받았어야 하는 공시(시작 시 채우기 이후 접수분)
  const liveSource = liveBaseline ? unique.filter(rceptNo => rceptNo > liveBaseline!) : [];
  const liveMissing = liveSource.filter(rceptNo => !seen.has(rceptNo));
  console.log(`[dart-check] ${JSON.stringify({
    date: day,
    sourceTotal: unique.length,
    captured: unique.length - missing.length,
    missing: missing.length,
    live: { source: liveSource.length, captured: liveSource.length - liveMissing.length, baseline: liveBaseline },
    missingSamples: missing.slice(0, 10),
  })}`);
}

async function loop(client: DartClient) {
  if (stopping) return;
  let delay = isActiveHours() ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
  try {
    if (!backfilled) backfilled = await backfill(client);
    if (SELF_CHECK && backfilled && Date.now() - lastCheckAt >= SELF_CHECK_INTERVAL_MS) {
      // 당일 누락 점검(B-26): 오늘 전체 목록을 먼저 받고, 그다음 평소 조회를 한 뒤 비교한다.
      // 목록이 조회보다 먼저라서, 목록에 있는 공시는 모두 이번 조회까지 받았어야 한다.
      const day = toDartDate(seoulDate());
      const source = await fetchDayRceptNos(client, day);
      await pollOnce(client);
      reportSelfCheck(day, source);
      lastCheckAt = Date.now();
    } else {
      await pollOnce(client);
    }
    consecutiveFailures = 0;
  } catch (error) {
    consecutiveFailures += 1;
    delay = retryDelay(error);
    console.warn(`[dart] collection failed: ${describeError(error)}. Next try in ${Math.round(delay / 1000)}s`);
  }
  if (!stopping) timer = setTimeout(() => void loop(client), delay);
}

async function main() {
  console.log('Disclosure collector starting...');
  startMetricsServer(metricsConfig.port);
  startMetricsLog('disclosure-collector', metricsConfig.logIntervalMs);

  const config = readDartConfig();
  if (!config) {
    configured.set({}, 0);
    console.warn('[dart] DART_API_KEY is not configured. Disclosure collection is idle.');
    registerShutdown('disclosure-collector', []);
    return;
  }
  configured.set({}, 1);

  await producer.connect();
  await ensureTopics();
  const client = new DartClient(config);
  registerShutdown('disclosure-collector', [
    { name: 'poll loop', run: () => { stopping = true; clearTimeout(timer); } },
    { name: 'kafka producer', run: () => producer.disconnect() },
  ]);
  console.log(`[dart] configured (scope ${DISCLOSURE_SCOPE}). Polling every ${ACTIVE_INTERVAL_MS}ms on weekdays 07-19 KST, ${IDLE_INTERVAL_MS}ms otherwise.`);
  void loop(client);
}

main().catch(error => {
  console.error(`Disclosure collector failed to start: ${error instanceof Error ? error.message : 'unexpected_error'}`);
  process.exit(1);
});
