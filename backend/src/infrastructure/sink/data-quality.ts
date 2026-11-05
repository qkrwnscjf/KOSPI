// 데이터 품질 검사 (docs/Task_ORDER.md T-119, BENCHMARK B-62, docs/data_catalog.md)
// db-sink가 15분마다 API별 규칙을 읽기 전용 쿼리로 확인하고 결과를 dq_results에 남긴다. 값을 고치지는 않는다.
// 상태: ok = 이상 없음, warn = 확인 필요(공휴일 등 정상일 수도 있음), fail = 데이터가 틀렸거나 수집 전체가 멈춤, error = 검사 자체 실패.
// detail에는 공개 시세의 심볼·날짜만 넣는다.

import { KRX_DAILY_KEYS } from '../../shared/krx-indices.js';
import { MARKET_FLOW_METRICS } from '../../shared/market-flows.js';
import { YAHOO_KEYS, type YahooSymbolKey } from '../../shared/symbols.js';
import { BAR_RESOLUTIONS, type BarResolution } from '../../shared/yahoo-bars.js';
import { latestSessionEnd, MARKETS, YAHOO_MARKET, type MarketId } from '../ingestion/market-hours.js';
import { safeLogText } from '../http-json.js';
import { usesOfficialDailyClose } from './daily-history.js';
import { FILL_PLANS, findGap, needsFill } from './intraday-fill.js';

export type DqStatus = 'ok' | 'warn' | 'fail' | 'error';
export interface DqResult {
  dataset: string;
  check: string;
  status: DqStatus;
  observed: number;
  expected: number | null;
  detail: string[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;
const DETAIL_LIMIT = 10;

const isOpenAt = (market: MarketId, ms: number) => MARKETS.find(item => item.id === market)?.isOpen(new Date(ms)) ?? false;
const issues = (dataset: string, check: string, items: string[], severity: DqStatus = 'warn'): DqResult => ({
  dataset, check, status: items.length === 0 ? 'ok' : severity, observed: items.length, expected: 0, detail: items.slice(0, DETAIL_LIMIT),
});

// ── 순수 함수 (테스트 대상) ──

// 장이 열린 지표의 마지막 시세 나이. 소스 지연(최대 약 20분)보다 넉넉하게 두고, 막 열린 시장은 보지 않는다.
// VIX는 수집 분류는 24시간 시장이지만 값이 끊기는 시간이 있어 미국 장 시간에만 본다.
export function evalFreshness(latest: ReadonlyMap<string, number>, nowMs: number): DqResult {
  const market = (key: YahooSymbolKey): MarketId => (key === 'VIX' ? 'us_equity' : YAHOO_MARKET[key]);
  const limit = (key: YahooSymbolKey) => (market(key) === 'global_24h' ? 90 * MINUTE : 40 * MINUTE);
  const open = YAHOO_KEYS.filter(key => isOpenAt(market(key), nowMs) && isOpenAt(market(key), nowMs - limit(key)));
  const stale = open.filter(key => nowMs - (latest.get(key) ?? 0) > limit(key));
  // 일부만 멈춘 것은 공휴일(미국 채권 휴장 등)일 수 있어 warn. 열린 지표가 모두 멈췄으면 수집 중단으로 본다
  const status: DqStatus = stale.length === 0 ? 'ok' : stale.length === open.length ? 'fail' : 'warn';
  return { dataset: 'yahoo_quote', check: 'freshness', status, observed: stale.length, expected: 0, detail: stale.slice(0, DETAIL_LIMIT) };
}

// 장이 끝나고 2시간이 지났는데 그 장의 공식 종가가 없는 지표. 평일 공휴일에는 warn으로 나온다.
// 코스피 200은 Yahoo 일봉이 없고 KRX 값이 늦게 공개되어 빠진 날 검사(krx_index)가 맡는다.
export function evalCloseMissing(latestDaily: ReadonlyMap<string, number>, nowMs: number): DqResult {
  const missing = YAHOO_KEYS.filter(key => {
    if (!usesOfficialDailyClose(key) || key === 'KOSPI200') return false;
    const sessionEnd = latestSessionEnd(YAHOO_MARKET[key], nowMs, 2 * HOUR);
    if (sessionEnd === null) return false;
    const last = latestDaily.get(key);
    return last === undefined || sessionEnd - last > 20 * HOUR;
  });
  return issues('yahoo_chart', 'close_missing', missing);
}

// 있어야 할 날짜(expected)에 없는 항목. 항목이 시작된 날 이전은 보지 않는다.
export function evalMissingDays(expected: readonly string[], present: ReadonlyMap<string, readonly string[]>, keys: readonly string[]): string[] {
  return keys.flatMap(key => {
    const days = new Set(present.get(key) ?? []);
    const first = [...days].sort()[0];
    return expected.filter(day => !days.has(day) && (first === undefined || day >= first)).map(day => `${key}:${day}`);
  });
}

// 표마다 (보관 기간 + 청크 간격 + 여유). 보관 정책은 청크 전체가 기간을 넘겨야 지우므로 청크 간격만큼 더 남을 수 있다.
export const RETENTION_LIMITS: Record<string, { column: string; limitMs: number }> = {
  market_ticks: { column: 'time', limitMs: 6 * HOUR },
  market_5m: { column: 'bucket', limitMs: YEAR + 8 * DAY },
  market_1h: { column: 'bucket', limitMs: YEAR + 31 * DAY },
  market_1d: { column: 'bucket', limitMs: YEAR + 31 * DAY },
  index_daily_krx: { column: 'time', limitMs: YEAR + 91 * DAY },
  index_daily_yahoo: { column: 'time', limitMs: YEAR + 91 * DAY },
  disclosures: { column: 'rcept_date', limitMs: YEAR + 31 * DAY },
  market_breadth: { column: 'time', limitMs: YEAR + 366 * DAY },
  stock_rankings: { column: 'time', limitMs: YEAR + 31 * DAY },
  market_flows: { column: 'time', limitMs: YEAR + 366 * DAY },
  market_bars_fill: { column: 'time', limitMs: 10 * DAY },
  investor_flows: { column: 'time', limitMs: YEAR + 8 * DAY },
  ingestion_runs: { column: 'started_at', limitMs: 38 * DAY },
  dq_results: { column: 'checked_at', limitMs: 38 * DAY },
};

export const evalRetention = (ages: readonly { name: string; age_ms: number | null }[]) =>
  ages.filter(row => row.age_ms !== null && row.age_ms > (RETENTION_LIMITS[row.name]?.limitMs ?? Infinity)).map(row => row.name);

// 수집 경로별 마지막 성공 실행의 허용 나이. KRX·Yahoo 차트는 받을 날짜가 있을 때만 실행되어 주말·연휴를 포함해 넉넉하게 둔다.
export const RUN_LIMITS: Record<string, number> = {
  yahoo_quote: 10 * MINUTE,
  yahoo_chart: 96 * HOUR,
  krx_index: 96 * HOUR,
  krx_stock: 96 * HOUR,
  dart: 30 * MINUTE,
  kofia: 13 * HOUR,
};

const STOCK_CODES: Record<string, string> = { '005930': 'SAMSUNG', '000660': 'SK_HYNIX', '005380': 'HYUNDAI' };
const CROSS_TOLERANCE_RATIO = 0.0001; // 0.01%. 반올림 차이만 허용한다

// ── 검사 묶음 ──

const dayExpr = (column: string) => `to_char(${column} AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`;
const WINDOW = `time >= now() - INTERVAL '30 days' AND time < now() - INTERVAL '2 days'`; // 최근 이틀은 KRX 공개 전일 수 있다

async function yahooQuoteChecks(query: QueryFn, nowMs: number): Promise<DqResult[]> {
  const latest = await query(`SELECT symbol, (extract(epoch FROM max(time)) * 1000)::float8 AS ms FROM market_ticks GROUP BY symbol`);
  const future = await query(`SELECT DISTINCT symbol FROM market_ticks WHERE time > now() + INTERVAL '5 minutes'`);
  const jumps = await query(
    `SELECT DISTINCT symbol FROM (
       SELECT symbol, price, lag(price) OVER (PARTITION BY symbol ORDER BY time) AS prev FROM market_ticks
     ) t WHERE prev > 0 AND abs(price / prev - 1) > 0.2`
  );
  // 등락률은 등락폭 ÷ 전일 종가와 맞아야 한다 (같은 응답의 값끼리 비교)
  const rates = await query(
    `SELECT DISTINCT symbol FROM market_ticks
     WHERE price - change_price > 0 AND abs(change_rate - change_price / (price - change_price) * 100) > 0.1`
  );
  return [
    evalFreshness(new Map(latest.rows.map(row => [row.symbol as string, row.ms as number])), nowMs),
    issues('yahoo_quote', 'future_time', future.rows.map(row => row.symbol), 'fail'),
    issues('yahoo_quote', 'price_jump', jumps.rows.map(row => row.symbol)),
    issues('yahoo_quote', 'rate_consistency', rates.rows.map(row => row.symbol)),
    ...(await Promise.all(BAR_RESOLUTIONS.map(resolution => graphGap(query, resolution, nowMs)))),
  ];
}

// 그래프 공백: 장이 열려 있던 칸 중 집계에도 채운 봉에도 없는 칸. Yahoo에 이미 요청해 본 칸은 빼서 공휴일 등을 다시 잡지 않는다
async function graphGap(query: QueryFn, resolution: BarResolution, nowMs: number): Promise<DqResult> {
  const plan = FILL_PLANS[resolution];
  const seconds = plan.windowMs / 1000;
  const { rows } = await query(
    `SELECT symbol, array_agg(ms) AS times FROM (
       SELECT symbol, (extract(epoch FROM bucket) * 1000)::float8 AS ms FROM ${plan.view} WHERE bucket >= now() - make_interval(secs => $1)
       UNION
       SELECT symbol, (extract(epoch FROM time) * 1000)::float8 FROM market_bars_fill WHERE resolution = $2 AND time >= now() - make_interval(secs => $1)
     ) x GROUP BY symbol`,
    [seconds, resolution]
  );
  const runs = await query(`SELECT symbol, (extract(epoch FROM fetched_at) * 1000)::float8 AS ms FROM market_bars_fill_runs WHERE resolution = $1`, [resolution]);
  const times = new Map(rows.map(row => [row.symbol as string, row.times as number[]]));
  const fetched = new Map(runs.rows.map(row => [row.symbol as string, row.ms as number]));
  const gaps = YAHOO_KEYS.filter(key => needsFill(findGap(times.get(key) ?? [], YAHOO_MARKET[key], resolution, nowMs, fetched.get(key) ?? null), resolution));
  return issues('yahoo_quote', `graph_gap_${resolution}`, gaps);
}

async function yahooChartChecks(query: QueryFn, nowMs: number): Promise<DqResult[]> {
  // 일봉 날짜는 거래일이어야 한다: 주말 날짜나, 그 시각이 아직 오지 않은 날짜는 잘못 붙은 값이다
  const labels = await query(
    `SELECT symbol, ${dayExpr('time')} AS day FROM index_daily_yahoo
     WHERE time >= now() - INTERVAL '30 days'
       AND (extract(isodow FROM time AT TIME ZONE 'Asia/Seoul') IN (6, 7) OR time > now())
     ORDER BY day DESC`
  );
  // 하루 밀림: 일봉 값이 그날 집계 종가와 다르고 전날 집계 종가와 같으면 날짜가 밀린 값으로 의심한다
  const usKeys = YAHOO_KEYS.filter(key => YAHOO_MARKET[key] === 'us_equity');
  const shifted = await query(
    `SELECT y.symbol, ${dayExpr('y.time')} AS day
     FROM index_daily_yahoo y
     JOIN (
       SELECT symbol, bucket, close, lag(close) OVER (PARTITION BY symbol ORDER BY bucket) AS prev
       FROM market_1d WHERE symbol = ANY($1::text[]) AND bucket >= now() - INTERVAL '21 days'
     ) a ON a.symbol = y.symbol AND a.bucket = time_bucket(INTERVAL '1 day', y.time)
     WHERE y.time >= now() - INTERVAL '14 days' AND a.prev IS NOT NULL
       AND abs(y.close - a.prev) <= 0.0001 * a.prev AND abs(y.close - a.close) > 0.0001 * a.close
     ORDER BY day DESC`,
    [usKeys]
  );
  const latest = await query(`SELECT symbol, (extract(epoch FROM max(time)) * 1000)::float8 AS ms FROM index_daily_yahoo GROUP BY symbol`);
  const jumps = await query(`SELECT DISTINCT symbol FROM index_daily_yahoo WHERE time >= now() - INTERVAL '14 days' AND abs(change_rate) > 30`);
  return [
    issues('yahoo_chart', 'date_label', labels.rows.map(row => `${row.symbol}:${row.day}`), 'fail'),
    issues('yahoo_chart', 'date_shift', shifted.rows.map(row => `${row.symbol}:${row.day}`)),
    evalCloseMissing(new Map(latest.rows.map(row => [row.symbol as string, row.ms as number])), nowMs),
    issues('yahoo_chart', 'daily_jump', jumps.rows.map(row => row.symbol)),
  ];
}

// 있어야 할 거래일: KRX 값이 하나라도 있거나 Yahoo 코스피 일봉이 있는 날
async function expectedTradeDays(query: QueryFn): Promise<string[]> {
  const { rows } = await query(
    `SELECT DISTINCT ${dayExpr('time')} AS day FROM (
       SELECT time FROM index_daily_krx WHERE ${WINDOW}
       UNION ALL SELECT time FROM index_daily_yahoo WHERE symbol = 'KOSPI' AND ${WINDOW}
     ) x ORDER BY day`
  );
  return rows.map(row => row.day as string);
}

async function daysByKey(query: QueryFn, table: string, keyColumn: string) {
  const { rows } = await query(`SELECT ${keyColumn} AS key, array_agg(DISTINCT ${dayExpr('time')}) AS days FROM ${table} WHERE ${WINDOW} GROUP BY ${keyColumn}`);
  return new Map(rows.map(row => [row.key as string, row.days as string[]]));
}

async function krxChecks(query: QueryFn): Promise<DqResult[]> {
  const expected = await expectedTradeDays(query);
  // 코스피(KRX)는 대조용으로 최근 값만 받으므로 빠진 날 검사에서 뺀다
  const indexKeys = [...KRX_DAILY_KEYS, 'KOSPI200'];
  const missing = evalMissingDays(expected, await daysByKey(query, 'index_daily_krx', 'symbol'), indexKeys);
  // 소스 간 대조: 코스피는 KRX 지수 값, 대형주 3종은 KRX 종목 순위의 종가와 Yahoo 일봉을 비교한다 (호출을 늘리지 않음)
  const cross = await query(
    `SELECT y.symbol, ${dayExpr('y.time')} AS day, y.close AS yahoo, k.close AS krx
     FROM index_daily_yahoo y
     JOIN (
       SELECT symbol, time, close FROM index_daily_krx WHERE symbol = 'KOSPI'
       UNION ALL
       SELECT (ARRAY[${Object.values(STOCK_CODES).map(name => `'${name}'`).join(',')}])[array_position(ARRAY[${Object.keys(STOCK_CODES).map(code => `'${code}'`).join(',')}], code)] AS symbol, time, close
       FROM stock_rankings WHERE market = 'KOSPI' AND code = ANY($1::text[])
     ) k ON k.symbol = y.symbol AND k.time = y.time
     WHERE y.time >= now() - INTERVAL '14 days'
     ORDER BY day DESC`,
    [Object.keys(STOCK_CODES)]
  );
  const mismatched = cross.rows.filter(row => Math.abs(row.yahoo - row.krx) > CROSS_TOLERANCE_RATIO * row.krx).map(row => `${row.symbol}:${row.day}`);
  const jumps = await query(`SELECT DISTINCT symbol FROM index_daily_krx WHERE time >= now() - INTERVAL '14 days' AND abs(change_rate) > 30`);
  return [
    issues('krx_index', 'missing_days', missing, 'fail'),
    // 비교한 쌍이 없으면 대조가 돌지 않은 것이므로 warn
    cross.rows.length === 0
      ? { dataset: 'krx_index', check: 'cross_source', status: 'warn', observed: 0, expected: null, detail: ['no_overlap'] }
      : { ...issues('krx_index', 'cross_source', mismatched, 'fail'), expected: 0, detail: mismatched.length > 0 ? mismatched.slice(0, DETAIL_LIMIT) : [`compared:${cross.rows.length}`] },
    issues('krx_index', 'daily_jump', jumps.rows.map(row => row.symbol)),
  ];
}

async function krxStockChecks(query: QueryFn): Promise<DqResult[]> {
  const expected = await expectedTradeDays(query);
  const markets = ['KOSPI', 'KOSDAQ'];
  const sums = await query(
    `SELECT market, ${dayExpr('time')} AS day FROM market_breadth
     WHERE time >= now() - INTERVAL '30 days' AND advancers + decliners + unchanged <> stocks`
  );
  const ranks = await query(
    `SELECT market, day, kind FROM (
       ${['gain', 'loss', 'value', 'cap'].map(kind => `SELECT market, ${dayExpr('time')} AS day, '${kind}' AS kind, count(rank_${kind}) AS n, max(rank_${kind}) AS top
         FROM stock_rankings WHERE time >= now() - INTERVAL '14 days' GROUP BY market, day`).join(' UNION ALL ')}
     ) x WHERE n <> top OR top > 100`
  );
  return [
    issues('krx_stock', 'breadth_missing', evalMissingDays(expected, await daysByKey(query, 'market_breadth', 'market'), markets), 'fail'),
    issues('krx_stock', 'rankings_missing', evalMissingDays(expected, await daysByKey(query, 'stock_rankings', 'market'), markets), 'fail'),
    issues('krx_stock', 'breadth_sum', sums.rows.map(row => `${row.market}:${row.day}`), 'fail'),
    issues('krx_stock', 'rankings_contiguous', ranks.rows.map(row => `${row.market}:${row.day}:${row.kind}`), 'fail'),
  ];
}

async function dartChecks(query: QueryFn): Promise<DqResult[]> {
  // 소스가 알려 준 전체 건수 대비 수집기가 읽은 건수 (가장 최근 정상 조회, 추가 호출 없음)
  const { rows: [run] } = await query(
    `SELECT source_total, covered FROM ingestion_runs
     WHERE source = 'dart' AND endpoint = 'list.json' AND source_total IS NOT NULL AND started_at >= now() - INTERVAL '1 hour'
     ORDER BY started_at DESC LIMIT 1`
  );
  const missing = run ? Math.max(0, run.source_total - run.covered) : 0;
  const { rows: [fill] } = await query(
    `SELECT count(amount)::float8 / NULLIF(count(*), 0) AS ratio FROM disclosures
     WHERE rcept_date >= current_date - 90 AND is_correction = false
       AND event_group = ANY(ARRAY['dilution', 'shareholder_return', 'treasury_disposal'])`
  );
  const ratio = fill?.ratio ?? null;
  return [
    { dataset: 'dart', check: 'source_coverage', status: missing > 0 ? 'fail' : 'ok', observed: missing, expected: 0, detail: run ? [`source_total:${run.source_total}`] : ['no_recent_run'] },
    { dataset: 'dart', check: 'amount_fill', status: ratio !== null && ratio < 0.3 ? 'warn' : 'ok', observed: ratio ?? 0, expected: 0.3, detail: [] },
  ];
}

async function kofiaChecks(query: QueryFn): Promise<DqResult[]> {
  const metrics = Object.keys(MARKET_FLOW_METRICS);
  const incomplete = await query(
    `SELECT ${dayExpr('time')} AS day FROM market_flows WHERE time >= now() - INTERVAL '31 days' AND metric = ANY($1::text[])
     GROUP BY 1 HAVING count(DISTINCT metric) <> $2 ORDER BY day DESC`,
    [metrics, metrics.length]
  );
  const { rows: [latest] } = await query(`SELECT extract(epoch FROM now() - max(time))::float8 / 86400 AS days FROM market_flows`);
  const lagDays = latest?.days ?? null;
  return [
    issues('kofia', 'metric_complete', incomplete.rows.map(row => row.day), 'fail'),
    // 값은 영업일 기준 2 ~ 3일 늦게 공개된다(B-47). 주말·연휴를 포함해 7일을 넘으면 확인한다
    { dataset: 'kofia', check: 'publish_lag', status: lagDays === null || lagDays > 7 ? 'warn' : 'ok', observed: lagDays ?? 0, expected: 7, detail: [] },
  ];
}

async function ingestionChecks(query: QueryFn): Promise<DqResult[]> {
  const latest = await query(`SELECT source, extract(epoch FROM now() - max(started_at))::float8 * 1000 AS age_ms FROM ingestion_runs WHERE status IN ('ok', 'empty') GROUP BY source`);
  const ages = new Map(latest.rows.map(row => [row.source as string, row.age_ms as number]));
  const stale = Object.keys(RUN_LIMITS).filter(source => (ages.get(source) ?? Infinity) > (RUN_LIMITS[source] ?? Infinity));
  const recent = await query(
    `SELECT source, count(*) FILTER (WHERE status = 'error')::float8 AS errors, count(*)::float8 AS runs,
            sum(dropped_total)::float8 AS dropped, sum(received)::float8 AS received
     FROM ingestion_runs WHERE started_at >= now() - INTERVAL '1 hour' GROUP BY source`
  );
  const failing = recent.rows.filter(row => row.errors / row.runs > 0.2).map(row => row.source);
  const dropping = recent.rows.filter(row => row.dropped > 0 && row.dropped / (row.received + row.dropped) > 0.05).map(row => row.source);
  return [
    issues('ingestion', 'run_recent', stale),
    issues('ingestion', 'run_errors', failing),
    issues('ingestion', 'drop_ratio', dropping),
  ];
}

async function dbChecks(query: QueryFn): Promise<DqResult[]> {
  // 보관 정책이 실제로 지우고 있는지 (표 이름·칼럼은 코드의 고정 표에서만 온다)
  const ages = await query(
    Object.entries(RETENTION_LIMITS)
      .map(([name, { column }]) => `SELECT '${name}' AS name, (extract(epoch FROM now() - min(${column})) * 1000)::float8 AS age_ms FROM ${name}`)
      .join(' UNION ALL ')
  );
  const jobs = await query(
    `SELECT replace(j.proc_name, 'policy_', '') || ':' || COALESCE(ca.view_name::text, j.hypertable_name::text) AS job,
            s.last_run_status AS status,
            extract(epoch FROM now() - s.last_successful_finish)::float8 AS age_s,
            extract(epoch FROM j.schedule_interval)::float8 AS schedule_s
     FROM timescaledb_information.jobs j
     LEFT JOIN timescaledb_information.job_stats s ON s.job_id = j.job_id
     LEFT JOIN timescaledb_information.continuous_aggregates ca
       ON ca.materialization_hypertable_schema = j.hypertable_schema AND ca.materialization_hypertable_name = j.hypertable_name
     WHERE j.proc_name IN ('policy_retention', 'policy_refresh_continuous_aggregate')`
  );
  const unhealthy = jobs.rows.filter(row => row.status === 'Failed' || (row.age_s !== null && row.age_s > 3 * row.schedule_s)).map(row => row.job);
  return [
    issues('db', 'retention_overdue', evalRetention(ages.rows)),
    issues('db', 'jobs', unhealthy),
  ];
}

// 모든 검사를 실행한다. 한 묶음이 실패해도 나머지는 계속한다.
export async function runChecks(query: QueryFn, nowMs = Date.now()): Promise<DqResult[]> {
  const groups: [string, () => Promise<DqResult[]>][] = [
    ['yahoo_quote', () => yahooQuoteChecks(query, nowMs)],
    ['yahoo_chart', () => yahooChartChecks(query, nowMs)],
    ['krx_index', () => krxChecks(query)],
    ['krx_stock', () => krxStockChecks(query)],
    ['dart', () => dartChecks(query)],
    ['kofia', () => kofiaChecks(query)],
    ['ingestion', () => ingestionChecks(query)],
    ['db', () => dbChecks(query)],
  ];
  const results: DqResult[] = [];
  for (const [dataset, run] of groups) {
    try {
      results.push(...(await run()));
    } catch (error) {
      results.push({ dataset, check: 'check_failed', status: 'error', observed: 1, expected: 0, detail: [safeLogText(error instanceof Error ? error.message : 'unexpected_error', 120)] });
    }
  }
  return results;
}

export async function storeResults(query: QueryFn, results: DqResult[], nowMs = Date.now()) {
  if (results.length === 0) return;
  const values: unknown[] = [];
  const rows = results.map((result, index) => {
    const base = index * 7;
    values.push(nowMs, result.dataset, result.check, result.status, result.observed, result.expected, JSON.stringify(result.detail));
    return `(to_timestamp($${base + 1} / 1000.0), $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb)`;
  });
  await query(`INSERT INTO dq_results (checked_at, dataset, check_name, status, observed, expected, detail) VALUES ${rows.join(', ')}`, values);
}
