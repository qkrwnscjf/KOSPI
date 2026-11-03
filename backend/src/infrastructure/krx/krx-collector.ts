import { producer, TOPICS, ensureTopics } from '../kafka.js';
import { Counter, Gauge, Latency, metricsConfig, startMetricsLog, startMetricsServer } from '../metrics.js';
import { registerShutdown } from '../shutdown.js';
import { KRX_DAILY_INDICES, KRX_DAILY_KEYS, KRX_HISTORY_KEYS, normalizeIndexName, type KrxEndpoint } from '../../shared/krx-indices.js';
import { fetchBreadthCoverage, fetchDailyIndexCoverage, fetchRankingsCoverage } from '../backend-coverage.js';
import type { TickData } from '../../shared/types.js';
import { KrxApiError, KrxClient, readKrxConfig } from './krx-client.js';
import { combineCoverage, ENDPOINT_PATHS, FIELDS, internalGaps, mapIndexRows, missingDates, parseKrxNumber, pastSeoulWeekdays, rowsOf, seoulWeekdays } from './krx-index-daily.js';
import { BREADTH_ENDPOINTS, rankStocks, STOCK_FIELDS, summarizeBreadth, type BreadthEndpoint } from './krx-breadth.js';
import { safeLogList } from '../http-json.js';
import { setWallClockTimeout, type WallClockTimer } from '../wall-clock-timer.js';
import { datesToCheck, recordCheck, type DateCheckState } from './krx-schedule.js';

// KRX 일별 지수 수집기 (docs/Task_ORDER.md T-67, D-60)
// VKOSPI와 KRX 섹터 5종의 일별 종가를 KRX Open API에서 받아 Kafka `index-daily`로 보낸다.
// - KRX 키를 가진 컨테이너는 이 수집기 하나뿐이다. 키가 없으면 접속하지 않고 대기한다.
// - 시작할 때 최근 KRX_BACKFILL_DAYS일(기본 370일)을 한 번 채우고, 이후에는 KRX_POLLING_INTERVAL_MS마다 최근 7일 중
//   아직 받지 않은(또는 정정 확인할) 날짜만 받는다 (krx-schedule.ts, T-132).
//   DB는 (symbol, time) 기준으로 덮어쓰므로 다시 보내도 중복이 생기지 않는다.
// - 값이 바뀐(또는 새로 생긴) 날짜만 보낸다.

const readIntEnv = (name: string, fallback: number) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isNaN(value) ? fallback : value;
};
const BACKFILL_DAYS = readIntEnv('KRX_BACKFILL_DAYS', 370);
const POLLING_INTERVAL_MS = readIntEnv('KRX_POLLING_INTERVAL_MS', 30 * 60_000);
const RECENT_DAYS = 7;
const REQUEST_GAP_MS = 200; // 호출 사이 간격 (KRX 호출 제한 보호)
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
const ENDPOINTS: KrxEndpoint[] = ['krx', 'drvprod'];

const fetchTotal = new Counter('kospi_krx_fetch_total', 'KRX daily index fetches by endpoint and result (ok / empty / error)');
const fetchDuration = new Latency('kospi_krx_fetch_duration_seconds', 'KRX daily index fetch duration');
const sentTotal = new Counter('kospi_krx_ticks_sent_total', 'Daily index values sent to Kafka by symbol');
const invalidTotal = new Counter('kospi_krx_invalid_rows_total', 'Target index rows dropped because a value was missing, by symbol');
const configured = new Gauge('kospi_krx_configured', 'Whether the KRX API key is configured (1) or not (0)');
const lastSuccessAt = new Gauge('kospi_krx_last_success_timestamp_seconds', 'Unix time of the last successful KRX fetch, by endpoint');
const latestTradeDate = new Gauge('kospi_krx_latest_trade_date', 'Latest trade date received (YYYYMMDD as a number), by symbol');

// 시장 폭·거래대금 (T-106): 종목별 일별매매정보를 시장별 합계로 줄여 보낸다. 값이 하루 한 번 바뀌므로 최근 3일만 다시 확인한다
const BREADTH_RECENT_DAYS = 3;
const BREADTH_ENDPOINT_LIST = Object.keys(BREADTH_ENDPOINTS) as BreadthEndpoint[];
const breadthSentTotal = new Counter('kospi_krx_breadth_sent_total', 'Market breadth summaries sent to Kafka by market');
const breadthInvalidRows = new Counter('kospi_krx_breadth_invalid_rows_total', 'Stock rows left out of the breadth summary because a value was missing, by market');
// 종목 순위 (T-113): 같은 응답에서 상위 100개만 보낸다
const rankingsSentTotal = new Counter('kospi_krx_rankings_sent_total', 'Stock ranking sets (one market-day) sent to Kafka by market');

const lastSent = new Map<string, string>();
// 엔드포인트 이름: 지수(krx, drvprod, kospi)와 종목별 매매정보(stk, ksq)
const loggedFields = new Set<string>();
const loggedMissing = new Set<KrxEndpoint>();
let stopping = false;
let timer: WallClockTimer | undefined;
let consecutiveFailures = 0;

// 인증 거부(401/403)를 받은 엔드포인트는 한동안 호출하지 않는다 (키 미승인 상태에서 반복 호출 방지).
// KRX Open API는 키 발급 후 서비스(API)별로 이용 신청·승인을 받아야 호출할 수 있다.
const AUTH_RETRY_MS = 6 * 60 * 60_000;
const disabledUntil = new Map<string, number>();
const backfilled = new Set<string>();
const unauthorized = new Counter('kospi_krx_unauthorized_total', 'KRX requests rejected as unauthorized (401/403), by endpoint');
const RATE_LIMIT_RETRY_MS = 60 * 60_000;
const rateLimited = new Counter('kospi_krx_rate_limited_total', 'KRX requests rejected by rate limit (429), by endpoint');
const isEnabled = (endpoint: string) => (disabledUntil.get(endpoint) ?? 0) <= Date.now();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 최근 날짜 확인 일정 (T-132): 엔드포인트·날짜마다 받은 결과를 기억해서 필요한 날짜만 다시 받는다
const checkStates = new Map<string, Map<string, DateCheckState>>();
const statesFor = (endpoint: string) => {
  let states = checkStates.get(endpoint);
  if (!states) checkStates.set(endpoint, (states = new Map()));
  return states;
};
function noteCheck(endpoint: string, basDd: string, result: 'rows' | 'empty') {
  const states = statesFor(endpoint);
  states.set(basDd, recordCheck(states.get(basDd), result, Date.now()));
}
// 확인 범위(window, 오래된 날부터) 중 이번 주기에 받을 날짜. 범위를 벗어난 날짜의 상태는 지운다
function plannedDates(endpoint: string, window: string[]) {
  const states = statesFor(endpoint);
  const first = window[0];
  for (const date of states.keys()) if (first === undefined || date < first) states.delete(date);
  return datesToCheck(window, states, Date.now());
}

function describeError(error: unknown) {
  if (error instanceof KrxApiError) return `${error.message}${error.status ? ` status=${error.status}` : ''}${error.code ? ` code=${error.code}` : ''}`;
  return 'unexpected_error';
}

// 한 날짜·한 엔드포인트를 받아 바뀐 값만 Kafka로 보낸다. 성공하면 true
async function collectDay(client: KrxClient, endpoint: KrxEndpoint, basDd: string) {
  const startedAt = Date.now();
  try {
    const body = await client.get(ENDPOINT_PATHS[endpoint], basDd);
    fetchDuration.observe({}, Date.now() - startedAt);
    const rows = rowsOf(body);

    // 필드 매핑 확정용: 첫 응답의 필드 이름만 한 번 남긴다 (값은 남기지 않음)
    if (!loggedFields.has(endpoint) && rows[0]) {
      loggedFields.add(endpoint);
      console.log(`[krx] ${endpoint} response fields: ${safeLogList(Object.keys(rows[0]))}`);
    }
    if (rows.length === 0) {
      fetchTotal.inc({ endpoint, result: 'empty' });
      noteCheck(endpoint, basDd, 'empty');
      return true;
    }
    fetchTotal.inc({ endpoint, result: 'ok' });
    noteCheck(endpoint, basDd, 'rows');
    lastSuccessAt.set({ endpoint }, Math.floor(Date.now() / 1000));

    const { ticks, invalid } = mapIndexRows(endpoint, basDd, rows);
    for (const symbol of invalid) invalidTotal.inc({ symbol });
    // 대상 지수 이름이 응답에 없으면 한 번만 공개 지수 이름 일부를 남긴다 (이름 표 확정용)
    if (ticks.length === 0 && invalid.length === 0 && !loggedMissing.has(endpoint)) {
      loggedMissing.add(endpoint);
      const names = rows.map(row => row[FIELDS.name]).filter((name): name is string => typeof name === 'string');
      console.warn(`[krx] ${endpoint} ${basDd}: no target index matched among ${rows.length} rows. Names: ${safeLogList(names)}`);
    }

    const changed = ticks.filter(tick => lastSent.get(`${tick.symbol}|${basDd}`) !== `${tick.price}|${tick.changeRate}`);
    if (changed.length > 0) {
      const producedAt = Date.now();
      await producer.send({
        topic: TOPICS.indexDaily,
        messages: changed.map((tick: TickData) => ({
          key: tick.symbol,
          value: JSON.stringify({ ...tick, collectedAt: startedAt, producedAt }),
        })),
      });
      for (const tick of changed) {
        lastSent.set(`${tick.symbol}|${basDd}`, `${tick.price}|${tick.changeRate}`);
        sentTotal.inc({ symbol: tick.symbol });
        latestTradeDate.set({ symbol: tick.symbol }, Math.max(Number(basDd), 0));
      }
    }
    return true;
  } catch (error) {
    fetchDuration.observe({}, Date.now() - startedAt);
    return handleFetchError(endpoint, basDd, error);
  }
}

// 호출 실패 처리 (지수·종목별 매매정보 공통). 항상 false
function handleFetchError(endpoint: string, basDd: string, error: unknown) {
  fetchTotal.inc({ endpoint, result: 'error' });
  if (error instanceof KrxApiError && (error.status === 401 || error.status === 403)) {
    unauthorized.inc({ endpoint });
    disabledUntil.set(endpoint, Date.now() + AUTH_RETRY_MS);
    console.warn(`[krx] ${endpoint} rejected as unauthorized (${describeError(error)}). ` +
      `Check that this API service is approved for the key on the KRX Open API portal. Pausing this endpoint for ${AUTH_RETRY_MS / 3600_000}h.`);
    return false;
  }
  // 호출 제한(429)이면 과거 채우기가 날짜마다 계속 호출하지 않도록 그 엔드포인트를 1시간 멈춘다
  if (error instanceof KrxApiError && error.status === 429) {
    rateLimited.inc({ endpoint });
    disabledUntil.set(endpoint, Date.now() + RATE_LIMIT_RETRY_MS);
    console.warn(`[krx] ${endpoint} rate limited (${describeError(error)}). Pausing this endpoint for ${RATE_LIMIT_RETRY_MS / 60_000}m.`);
    return false;
  }
  console.warn(`[krx] ${endpoint} ${basDd} fetch failed: ${describeError(error)}`);
  return false;
}

// 시장 폭 (T-106): 한 날짜·한 시장의 종목별 매매정보를 받아 합계만 Kafka로 보낸다. 종목 행은 보내지 않는다. 성공하면 true
async function collectBreadthDay(client: KrxClient, endpoint: BreadthEndpoint, basDd: string) {
  const { path, market } = BREADTH_ENDPOINTS[endpoint];
  const startedAt = Date.now();
  try {
    const body = await client.get(path, basDd);
    fetchDuration.observe({}, Date.now() - startedAt);
    const rows = rowsOf(body);
    if (!loggedFields.has(endpoint) && rows[0]) {
      loggedFields.add(endpoint);
      console.log(`[krx] ${endpoint} response fields: ${safeLogList(Object.keys(rows[0]))} (${rows.length} rows)`);
    }
    if (rows.length === 0) {
      fetchTotal.inc({ endpoint, result: 'empty' });
      noteCheck(endpoint, basDd, 'empty');
      return true;
    }
    fetchTotal.inc({ endpoint, result: 'ok' });
    noteCheck(endpoint, basDd, 'rows');
    lastSuccessAt.set({ endpoint }, Math.floor(Date.now() / 1000));

    const { breadth, invalid } = summarizeBreadth(market, basDd, rows);
    if (invalid > 0) breadthInvalidRows.inc({ market }, invalid);
    if (!breadth) {
      // 쓸 수 있는 종목 행이 하나도 없으면(필드 이름이 다를 때) 한 번만 알린다
      if (!loggedFields.has(`${endpoint}:empty`)) {
        loggedFields.add(`${endpoint}:empty`);
        console.warn(`[krx] ${endpoint} ${basDd}: no usable stock rows among ${rows.length} (field mapping may differ)`);
      }
      return true;
    }
    const key = `breadth|${market}|${basDd}`;
    const signature = `${breadth.advancers}|${breadth.decliners}|${breadth.unchanged}|${breadth.tradingValue}`;
    if (lastSent.get(key) !== signature) {
      await producer.send({
        topic: TOPICS.breadth,
        messages: [{ key: market, value: JSON.stringify({ ...breadth, collectedAt: startedAt, producedAt: Date.now() }) }],
      });
      lastSent.set(key, signature);
      breadthSentTotal.inc({ market });
    }

    // 종목 순위 (T-113): 같은 응답에서 4가지 순위의 상위 100개만 보낸다(추가 호출 없음). 바뀐 날만 보낸다
    const rankings = rankStocks(market, basDd, rows);
    if (rankings) {
      const rankKey = `rankings|${market}|${basDd}`;
      const rankSignature = rankings.entries.map(entry => `${entry.code}:${entry.close}:${entry.changeRate}`).join(',');
      if (lastSent.get(rankKey) !== rankSignature) {
        await producer.send({
          topic: TOPICS.rankings,
          messages: [{ key: market, value: JSON.stringify({ ...rankings, collectedAt: startedAt, producedAt: Date.now() }) }],
        });
        lastSent.set(rankKey, rankSignature);
        rankingsSentTotal.inc({ market });
      }
    }
    return true;
  } catch (error) {
    fetchDuration.observe({}, Date.now() - startedAt);
    return handleFetchError(endpoint, basDd, error);
  }
}

// 시장 폭 날짜들을 오래된 순서로 받는다. 거부된 엔드포인트는 건너뛴다
async function collectBreadthDays(client: KrxClient, dates: string[], endpoints: BreadthEndpoint[]) {
  let failures = 0;
  for (const basDd of dates) {
    for (const endpoint of endpoints) {
      if (stopping) return failures === 0;
      if (!isEnabled(endpoint)) continue;
      if (!(await collectBreadthDay(client, endpoint, basDd))) failures += 1;
      await sleep(REQUEST_GAP_MS);
    }
  }
  return failures === 0;
}

// 날짜들을 오래된 순서로 받는다 (화면의 최신값이 마지막에 가장 최근 날짜로 남도록). 거부된 엔드포인트는 건너뛴다.
async function collectDays(client: KrxClient, dates: string[], endpoints: KrxEndpoint[]) {
  let failures = 0;
  for (const basDd of dates) {
    for (const endpoint of endpoints) {
      if (stopping) return failures === 0;
      if (!isEnabled(endpoint)) continue;
      if (!(await collectDay(client, endpoint, basDd))) failures += 1;
      await sleep(REQUEST_GAP_MS);
    }
  }
  return failures === 0;
}

// 과거 채우기: 이미 저장된 기간은 backend에 물어서 건너뛰고 빠진 날짜만 받는다 (docs/security.md SEC-014).
// 저장 범위를 확인하지 못하면 이번에는 채우지 않고 다음 주기에 다시 묻는다(재시작이 반복돼도 대량 호출이 생기지 않게).
// 받을 날짜가 있으면 먼저 최근 1개 거래일로 인증을 확인하고, 통과한 엔드포인트만 채운다. 최근 7일은 loop가 받는다.
const ENDPOINT_SYMBOLS: Record<KrxEndpoint, string[]> = {
  krx: KRX_DAILY_KEYS.filter(symbol => KRX_DAILY_INDICES[symbol].endpoint === 'krx'),
  drvprod: KRX_DAILY_KEYS.filter(symbol => KRX_DAILY_INDICES[symbol].endpoint === 'drvprod'),
  kospi: [...KRX_HISTORY_KEYS], // 과거 일봉 전용 (backfillHistory)
};
let loggedCoverageUnavailable = false;

async function backfill(client: KrxClient) {
  if (BACKFILL_DAYS <= RECENT_DAYS) return;
  const pending = ENDPOINTS.filter(endpoint => !backfilled.has(endpoint) && isEnabled(endpoint));
  if (stopping || pending.length === 0) return;

  const coverage = await fetchDailyIndexCoverage(pending.flatMap(endpoint => ENDPOINT_SYMBOLS[endpoint]));
  if (!coverage) {
    if (!loggedCoverageUnavailable) console.warn('[krx] stored range unavailable from backend; backfill postponed to the next cycle');
    loggedCoverageUnavailable = true;
    return;
  }

  const recent = seoulWeekdays(Date.now(), RECENT_DAYS);
  const target = seoulWeekdays(Date.now(), BACKFILL_DAYS).slice(0, -recent.length);
  for (const endpoint of pending) {
    if (stopping) return;
    const stored = combineCoverage(ENDPOINT_SYMBOLS[endpoint].map(symbol => coverage.get(symbol)));
    const dates = missingDates(target, stored);
    if (dates.length === 0) {
      backfilled.add(endpoint);
      console.log(`[krx] ${endpoint} backfill skipped: already stored ${stored?.earliest}-${stored?.latest}`);
      continue;
    }
    const probe = recent[recent.length - 1];
    if (probe && !(await collectDay(client, endpoint, probe)) && !isEnabled(endpoint)) continue;
    const startedAt = Date.now();
    const ok = await collectDays(client, dates, [endpoint]);
    if (!isEnabled(endpoint)) continue; // 채우는 중에 거부되면 다음에 다시
    backfilled.add(endpoint);
    console.log(`[krx] ${endpoint} backfill ${ok ? 'done' : 'finished with errors'}: ${dates.length} of ${target.length} trade days (stored ${stored ? `${stored.earliest}-${stored.latest}` : 'none'}) in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }
}

// Yahoo 지표의 과거 일봉 (T-104 보완): KOSPI 시리즈 일별 시세에서 코스피 200 종가를 받는다(index_daily에만 저장, 화면 tick 아님).
// 실시간 집계가 시작되기 전 기간만 필요하므로 저장된 첫 날짜보다 앞쪽(과 저장이 없으면 1년 전체)만 받는다. 오늘은 실시간 수집이 맡는다.
// 프로세스당 한 번만 하고, 저장 범위를 확인하지 못하면 다음 주기로 미룬다 (SEC-014).
// 저장된 범위 사이의 빈 날(스택이 꺼져 있던 날)은 최근 60일만 채운다(T-141). 오늘 집계가 먼저 생겨도 놓치지 않기 위함이다.
// 평일 공휴일은 응답이 비어 넘어간다(시작할 때 몇 번 더 호출).
const HISTORY_GAP_LOOKBACK_DAYS = 60;

async function backfillHistory(client: KrxClient) {
  const endpoint: KrxEndpoint = 'kospi';
  if (BACKFILL_DAYS <= 0 || stopping || backfilled.has(endpoint) || !isEnabled(endpoint)) return;
  const coverage = await fetchDailyIndexCoverage(ENDPOINT_SYMBOLS.kospi);
  if (!coverage) return;
  const target = pastSeoulWeekdays(Date.now(), BACKFILL_DAYS);
  const stored = combineCoverage(ENDPOINT_SYMBOLS.kospi.map(symbol => coverage.get(symbol)));
  const gaps = internalGaps(pastSeoulWeekdays(Date.now(), HISTORY_GAP_LOOKBACK_DAYS), ENDPOINT_SYMBOLS.kospi.map(symbol => coverage.get(symbol)?.days ?? new Set<string>()));
  const dates = [...new Set([...missingDates(target, stored), ...gaps])].sort();
  if (dates.length === 0) {
    backfilled.add(endpoint);
    console.log(`[krx] ${endpoint} history backfill skipped: already stored ${stored?.earliest}-${stored?.latest}`);
    return;
  }
  const startedAt = Date.now();
  const ok = await collectDays(client, dates, [endpoint]);
  if (!isEnabled(endpoint)) return; // 거부되면 정지 시간이 지난 뒤 다시
  backfilled.add(endpoint);
  console.log(`[krx] ${endpoint} history backfill ${ok ? 'done' : 'finished with errors'}: ${dates.length} trade days in ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

// 시장 폭 과거 채우기 (T-106): 지수와 같은 방식(빠진 기간만, 먼저 최근 1개 거래일로 인증 확인, 프로세스당 한 번)
let loggedBreadthCoverageUnavailable = false;

async function backfillBreadth(client: KrxClient) {
  if (BACKFILL_DAYS <= BREADTH_RECENT_DAYS) return;
  const pending = BREADTH_ENDPOINT_LIST.filter(endpoint => !backfilled.has(endpoint) && isEnabled(endpoint));
  if (stopping || pending.length === 0) return;

  const coverage = await fetchBreadthCoverage(pending.map(endpoint => BREADTH_ENDPOINTS[endpoint].market));
  if (!coverage) {
    if (!loggedBreadthCoverageUnavailable) console.warn('[krx] stored breadth range unavailable from backend; backfill postponed to the next cycle');
    loggedBreadthCoverageUnavailable = true;
    return;
  }

  const recent = seoulWeekdays(Date.now(), BREADTH_RECENT_DAYS);
  const target = seoulWeekdays(Date.now(), BACKFILL_DAYS).slice(0, -recent.length);
  for (const endpoint of pending) {
    if (stopping) return;
    const stored = coverage.get(BREADTH_ENDPOINTS[endpoint].market) ?? null;
    const dates = missingDates(target, stored);
    if (dates.length === 0) {
      backfilled.add(endpoint);
      console.log(`[krx] ${endpoint} breadth backfill skipped: already stored ${stored?.earliest}-${stored?.latest}`);
      continue;
    }
    const probe = recent[recent.length - 1];
    if (probe && !(await collectBreadthDay(client, endpoint, probe)) && !isEnabled(endpoint)) continue;
    const startedAt = Date.now();
    const ok = await collectBreadthDays(client, dates, [endpoint]);
    if (!isEnabled(endpoint)) continue;
    backfilled.add(endpoint);
    console.log(`[krx] ${endpoint} breadth backfill ${ok ? 'done' : 'finished with errors'}: ${dates.length} of ${target.length} trade days (stored ${stored ? `${stored.earliest}-${stored.latest}` : 'none'}) in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }
}

// 종목 순위 과거 채우기 (T-113): 순위는 시장 폭과 같은 응답에서 나오므로, 순위가 빠진 날짜만 다시 받는다
// (시장 폭은 같은 값으로 덮어쓰여 변화 없음). 저장 범위를 확인하지 못하면 다음 주기로 미룬다 (SEC-014). 프로세스당 한 번.
let loggedRankingsCoverageUnavailable = false;

async function backfillRankings(client: KrxClient) {
  if (BACKFILL_DAYS <= BREADTH_RECENT_DAYS) return;
  const pending = BREADTH_ENDPOINT_LIST.filter(endpoint => !backfilled.has(`rank:${endpoint}`) && isEnabled(endpoint));
  if (stopping || pending.length === 0) return;

  const coverage = await fetchRankingsCoverage(pending.map(endpoint => BREADTH_ENDPOINTS[endpoint].market));
  if (!coverage) {
    if (!loggedRankingsCoverageUnavailable) console.warn('[krx] stored rankings range unavailable from backend; backfill postponed to the next cycle');
    loggedRankingsCoverageUnavailable = true;
    return;
  }

  const recent = seoulWeekdays(Date.now(), BREADTH_RECENT_DAYS);
  const target = seoulWeekdays(Date.now(), BACKFILL_DAYS).slice(0, -recent.length);
  for (const endpoint of pending) {
    if (stopping) return;
    const stored = coverage.get(BREADTH_ENDPOINTS[endpoint].market) ?? null;
    const dates = missingDates(target, stored);
    if (dates.length === 0) {
      backfilled.add(`rank:${endpoint}`);
      console.log(`[krx] ${endpoint} rankings backfill skipped: already stored ${stored?.earliest}-${stored?.latest}`);
      continue;
    }
    const startedAt = Date.now();
    const ok = await collectBreadthDays(client, dates, [endpoint]);
    if (!isEnabled(endpoint)) continue;
    backfilled.add(`rank:${endpoint}`);
    console.log(`[krx] ${endpoint} rankings backfill ${ok ? 'done' : 'finished with errors'}: ${dates.length} of ${target.length} trade days (stored ${stored ? `${stored.earliest}-${stored.latest}` : 'none'}) in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }
}

// 검증용 공식 종가 대조 (기본 끔, BENCHMARK B-51): T-136이 화면에 쓰는 Yahoo 일봉이 거래소 공식 종가와 같은지 독립 기준으로 확인한다.
// 최근 2주 평일마다 이미 승인된 두 엔드포인트를 1번씩 받아 대상 5종의 종가만 로그로 남긴다(공개 시세). Kafka로 보내지 않고 저장하지 않는다.
const CLOSE_CHECK = process.env.KRX_CLOSE_CHECK === 'true';
const CLOSE_CHECK_DAYS = 14;
const CLOSE_CHECK_INDICES = new Map([['코스피', 'KOSPI'], ['코스피 200', 'KOSPI200']].map(([name, symbol]) => [normalizeIndexName(name!), symbol!]));
const CLOSE_CHECK_STOCKS = new Map([['005930', 'SAMSUNG'], ['000660', 'SK_HYNIX'], ['005380', 'HYUNDAI']]);

async function runCloseCheck(client: KrxClient) {
  console.warn('KRX_CLOSE_CHECK=true: logging official closes of 5 symbols for the last 2 weeks (verification only).');
  const closes: Record<string, Record<string, number | null>> = {};
  let calls = 0;
  for (const basDd of seoulWeekdays(Date.now(), CLOSE_CHECK_DAYS)) {
    const day: Record<string, number | null> = {};
    for (const [endpoint, path] of [['kospi', ENDPOINT_PATHS.kospi], ['stk', BREADTH_ENDPOINTS.stk.path]] as const) {
      if (stopping || !isEnabled(endpoint)) continue;
      calls += 1;
      try {
        for (const row of rowsOf(await client.get(path, basDd))) {
          const name = row[FIELDS.name];
          const code = row[STOCK_FIELDS.code];
          const symbol = endpoint === 'kospi'
            ? (typeof name === 'string' ? CLOSE_CHECK_INDICES.get(normalizeIndexName(name)) : undefined)
            : (typeof code === 'string' ? CLOSE_CHECK_STOCKS.get(code.trim()) : undefined);
          if (symbol) day[symbol] = parseKrxNumber(row[endpoint === 'kospi' ? FIELDS.close : STOCK_FIELDS.close]);
        }
      } catch (error) {
        handleFetchError(endpoint, basDd, error);
      }
      await sleep(REQUEST_GAP_MS);
    }
    if (Object.keys(day).length > 0) closes[`${basDd.slice(0, 4)}-${basDd.slice(4, 6)}-${basDd.slice(6, 8)}`] = day;
  }
  console.log(`[krx-close-check] ${JSON.stringify({ calls, closes })}`);
}

async function loop(client: KrxClient) {
  if (stopping) return;
  await backfill(client);
  await backfillHistory(client);
  await backfillBreadth(client);
  await backfillRankings(client);
  // 시장 폭은 자체 정지(거부·제한)로 보호하므로, 결과를 지수 수집의 재시도 간격(백오프)에 섞지 않는다
  // 최근 날짜는 확인 일정(T-132)에 따라 필요한 날짜만 받는다. 받을 날짜가 없으면 이번 주기는 호출하지 않는다
  const breadthWindow = seoulWeekdays(Date.now(), BREADTH_RECENT_DAYS);
  for (const endpoint of BREADTH_ENDPOINT_LIST) {
    await collectBreadthDays(client, plannedDates(endpoint, breadthWindow), [endpoint]);
  }
  const indexWindow = seoulWeekdays(Date.now(), RECENT_DAYS);
  let ok = true;
  for (const endpoint of ENDPOINTS) {
    ok = (await collectDays(client, plannedDates(endpoint, indexWindow), [endpoint])) && ok;
  }
  // 코스피 200 일봉 (T-141): Yahoo가 일봉을 주지 않아 공식 종가를 여기서 받는다. 시장 폭처럼 결과를 지수 수집의 백오프에 섞지 않는다
  await collectDays(client, plannedDates('kospi', indexWindow), ['kospi']);
  consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
  const delay = consecutiveFailures === 0 ? POLLING_INTERVAL_MS : Math.min(POLLING_INTERVAL_MS * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
  if (!stopping) timer = setWallClockTimeout(() => void loop(client), delay);
}

async function main() {
  console.log('KRX collector starting...');
  startMetricsServer(metricsConfig.port);
  startMetricsLog('krx-collector', metricsConfig.logIntervalMs);

  const config = readKrxConfig();
  if (!config) {
    configured.set({}, 0);
    console.warn('[krx] KRX_API_KEY is not configured. Daily index collection is idle.');
    registerShutdown('krx-collector', []);
    return;
  }
  configured.set({}, 1);

  await producer.connect();
  await ensureTopics();
  const client = new KrxClient(config);
  registerShutdown('krx-collector', [
    { name: 'poll loop', run: () => { stopping = true; timer?.cancel(); } },
    { name: 'kafka producer', run: () => producer.disconnect() },
  ]);

  console.log(`[krx] configured for ${KRX_DAILY_KEYS.length} indices. Backfill ${BACKFILL_DAYS} days, then every ${POLLING_INTERVAL_MS}ms.`);
  if (CLOSE_CHECK) await runCloseCheck(client);
  void loop(client);
}

main().catch(error => {
  console.error(`KRX collector failed to start: ${error instanceof Error ? error.message : 'unexpected_error'}`);
  process.exit(1);
});
