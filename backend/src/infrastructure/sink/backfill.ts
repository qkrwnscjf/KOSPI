import YahooFinance from 'yahoo-finance2';
import type { Producer } from 'kafkajs';
import { dbPool } from '../db.js';
import { TOPICS } from '../kafka.js';
import { Counter, Gauge, Latency } from '../metrics.js';
import { TimeoutError, withAbortTimeout } from '../abort-timeout.js';
import { YAHOO_CATEGORY, YAHOO_DAILY_HISTORY_KEYS, YAHOO_KEYS, YAHOO_SYMBOLS } from '../../shared/symbols.js';
import type { YahooSymbolKey } from '../../shared/symbols.js';
import type { YahooDailyMessage } from '../../shared/yahoo-daily.js';
import { latestSessionEnd, YAHOO_MARKET } from '../ingestion/market-hours.js';
import { CLOSE_FIX_DAYS, CLOSE_FIX_MARGIN_MS, GAP_LOOKBACK_DAYS, missingWeekdays, needsDailyHistory, shouldRefreshClose, toDailyRows, usesOfficialDailyClose, type DailyRow } from './daily-history.js';

// 최초 1회 과거 데이터 채우기 (docs/Task_ORDER.md T-19, R-05, D-06)
// 연속 집계에는 직접 넣을 수 없어서, 원본(market_ticks)에 종가를 넣고 → 집계를 전체 갱신하고 →
// 3시간보다 오래된 원본을 바로 지운다 (D-02). 집계는 원본이 지워져도 남는다.
// 완료 기록(backfill_runs)이 있으면 다시 실행하지 않는다.

// 버전 2: T-31(마이그레이션 3)에서 집계를 다시 만들었으므로 한 번 더 채운다 (D-27)
const BACKFILL_VERSION = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

// 그래프별로 필요한 해상도만 받는다: 1일 그래프(5분 봉 24시간), 1주 그래프(1시간 봉 7일), 1개월~1년 그래프(1일 봉).
const RANGES = [
  { interval: '1d', days: 366 },
  { interval: '60m', days: 8 },
  { interval: '5m', days: 2 },
] as const;

const yahooFinance = new YahooFinance();

interface BackfillRow {
  time: Date;
  symbol: YahooSymbolKey;
  price: number;
  changeRate: number;
  changePrice: number;
}

// 검증용 (기본 끔, BENCHMARK B-57): 지정한 지표의 Yahoo 호출이 응답 없이 기다리다 실패하는 상황을 흉내 낸다. 외부 호출은 하지 않는다
const TEST_STALL_SYMBOLS = new Set((process.env.YAHOO_TEST_STALL_SYMBOLS ?? '').split(',').filter(Boolean));
const TEST_STALL_MS = Number.parseInt(process.env.YAHOO_TEST_STALL_MS ?? '', 10) || 300_000;

const simulateStall = async (): Promise<never> => {
  await new Promise(resolve => setTimeout(resolve, TEST_STALL_MS));
  throw new Error('simulated stall (verification only)');
};

// Yahoo chart 호출 시간 제한 (T-150, B-57). 라이브러리에는 제한이 없고 호출은 지표마다 차례로 진행되므로,
// 한 지표가 응답하지 않으면 뒤의 지표가 모두 밀렸다. 1년치 일봉도 평소 수 초 안에 끝난다.
const CHART_TIMEOUT_MS = Number.parseInt(process.env.YAHOO_CHART_TIMEOUT_MS ?? '', 10) || 15_000;
const chartFetchTotal = new Counter('kospi_sink_yahoo_fetch_total', 'Yahoo chart calls from db-sink by result (ok / timeout / error)');
const chartFetchDuration = new Latency('kospi_sink_yahoo_fetch_duration_seconds', 'Yahoo chart call duration from db-sink');
const officialCloseLastSuccess = new Gauge('kospi_sink_official_close_last_success_timestamp_seconds', 'Unix time of the last successful official close fetch, by symbol');

async function fetchChart(symbol: YahooSymbolKey, interval: (typeof RANGES)[number]['interval'], days: number) {
  const startedAt = Date.now();
  try {
    const result = await withAbortTimeout(signal => (TEST_STALL_SYMBOLS.has(symbol)
      ? simulateStall()
      : yahooFinance.chart(YAHOO_SYMBOLS[symbol], { period1: new Date(Date.now() - days * DAY_MS), interval }, { fetchOptions: { signal } })), CHART_TIMEOUT_MS);
    chartFetchTotal.inc({ result: 'ok' });
    return result;
  } catch (error) {
    chartFetchTotal.inc({ result: error instanceof TimeoutError ? 'timeout' : 'error' });
    throw error;
  } finally {
    chartFetchDuration.observe({}, Date.now() - startedAt);
  }
}

async function fetchBars(symbol: YahooSymbolKey, interval: (typeof RANGES)[number]['interval'], days: number) {
  const result = await fetchChart(symbol, interval, days);

  // 종가가 없거나 0 이하인 봉은 넣지 않는다 (이전 History API는 이런 봉을 0으로 바꿨다, T-21).
  const bars = result.quotes.filter(
    quote => quote.date instanceof Date && typeof quote.close === 'number' && Number.isFinite(quote.close) && quote.close > 0
  );

  // 등락은 직전 봉 종가 대비로 계산한다. 비교할 직전 봉이 없는 첫 봉은 넣지 않는다 (값 없음을 0으로 채우지 않기 위함).
  const rows: BackfillRow[] = [];
  for (let index = 1; index < bars.length; index++) {
    const previous = bars[index - 1]?.close;
    const current = bars[index];
    if (!current || typeof previous !== 'number' || typeof current.close !== 'number') continue;
    rows.push({
      time: current.date,
      symbol,
      price: current.close,
      changePrice: current.close - previous,
      changeRate: ((current.close - previous) / previous) * 100,
    });
  }
  return rows;
}

async function insertRows(rows: BackfillRow[]) {
  let inserted = 0;
  for (let start = 0; start < rows.length; start += 500) {
    const chunk = rows.slice(start, start + 500);
    const values: unknown[] = [];
    const placeholders = chunk.map((row, index) => {
      const base = index * 6;
      values.push(row.time, row.symbol, YAHOO_CATEGORY[row.symbol], row.price, row.changeRate, row.changePrice);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });
    const result = await dbPool.query(
      `INSERT INTO market_ticks (time, symbol, category, price, change_rate, change_price)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (symbol, time) DO NOTHING`,
      values
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

export async function runBackfillOnce() {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS backfill_runs (
      version INTEGER PRIMARY KEY,
      rows_inserted INTEGER NOT NULL,
      finished_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const done = await dbPool.query('SELECT 1 FROM backfill_runs WHERE version = $1', [BACKFILL_VERSION]);
  if (done.rowCount) {
    console.log(`Backfill version ${BACKFILL_VERSION} already done, skipping.`);
    return;
  }

  console.log(`Backfill version ${BACKFILL_VERSION} starting (${YAHOO_KEYS.length} symbols x ${RANGES.length} ranges)...`);
  let inserted = 0;
  let failed = 0;
  for (const symbol of YAHOO_KEYS) {
    for (const range of RANGES) {
      try {
        const rows = await fetchBars(symbol, range.interval, range.days);
        const count = await insertRows(rows);
        inserted += count;
        console.log(`Backfill ${symbol} ${range.interval}: ${rows.length} bars, ${count} inserted`);
      } catch (error) {
        failed += 1;
        console.error(`Backfill ${symbol} ${range.interval} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  // 일부라도 실패하면 완료로 기록하지 않는다. 다음 기동에서 다시 시도한다 (이미 넣은 행은 유니크 제약으로 건너뜀).
  if (failed > 0) {
    throw new Error(`Backfill incomplete: ${failed} requests failed`);
  }

  // 집계를 아래 단계부터 전체 갱신한다 (계층형이라 순서가 중요, D-23).
  for (const view of ['market_5m', 'market_1h', 'market_1d']) {
    await dbPool.query(`CALL refresh_continuous_aggregate('${view}', NULL, NULL)`);
  }
  // 집계에 반영된 오래된 원본을 바로 지운다. 보관 정책(3시간)과 같은 기준이다 (D-02).
  const dropped = await dbPool.query(`SELECT drop_chunks('market_ticks', older_than => INTERVAL '3 hours')`);

  await dbPool.query('INSERT INTO backfill_runs (version, rows_inserted) VALUES ($1, $2)', [BACKFILL_VERSION, inserted]);
  console.log(`Backfill version ${BACKFILL_VERSION} done: ${inserted} rows inserted, aggregates refreshed, ${dropped.rowCount ?? 0} old raw chunks dropped.`);
}

// 나중에 추가한 Yahoo 지표의 과거 일봉 채우기 (docs/Task_ORDER.md T-104 ③, D-67)
// 이 지표들을 market_ticks에 넣고 집계를 다시 계산하면, 그 구간의 다른 지표 집계가 지워진다(원본이 이미 없음, D-23).
// 그래서 과거 일봉은 index_daily(source 'yahoo')에만 넣고 집계는 건드리지 않는다. History API가 그래프에서 이어 붙인다.
// 지표마다 마지막 일봉과 실시간 집계 첫날 사이가 비어 있을 때만 받는다(needsDailyHistory). 이미 있는 날짜는 건너뛴다.
// 빠진 날 메우기(T-127): 모든 Yahoo 지표에서 최근 한 달 중 집계·일봉 모두에 없는 평일이 있으면 그 날짜만 채운다(missingWeekdays).
// db-sink가 시작할 때와 그 뒤 주기적으로 확인한다. 실패한 지표는 다음 확인 때 다시 시도한다.
const GAP_REFETCH_MS = 20 * 60 * 60 * 1000; // 공휴일처럼 채울 수 없는 빈 날 때문에 같은 지표를 하루 한 번보다 자주 받지 않는다
const lastGapFetchAt = new Map<YahooSymbolKey, number>();
const historyKeys = new Set<YahooSymbolKey>(YAHOO_DAILY_HISTORY_KEYS);

// 일봉은 DB에 바로 쓰지 않고 Kafka로 보낸다(T-143). db-sink의 컨슈머가 검증 후 저장한다
async function sendDailyRows(producer: Producer, symbol: YahooSymbolKey, rows: DailyRow[], overwrite: boolean) {
  if (rows.length === 0) return;
  const producedAt = Date.now();
  await producer.send({
    topic: TOPICS.yahooDaily,
    messages: rows.map(row => {
      const message: YahooDailyMessage = { symbol, time: row.time, close: row.close, changeRate: row.changeRate, changePrice: row.changePrice, overwrite, producedAt };
      return { key: symbol, value: JSON.stringify(message) };
    }),
  });
}

export async function runDailyHistoryBackfill(producer: Producer) {
  for (const symbol of YAHOO_KEYS) {
    const { rows: [state] } = await dbPool.query<{ last_daily: number | null; first_agg: number | null; first_agg_day: string | null; agg_days: string[] | null; daily_days: string[] | null }>(
      // 마지막 일봉은 출처와 상관없이 본다 (Yahoo가 주지 않는 지표는 KRX 일봉이 있다, T-104 보완)
      `SELECT (SELECT extract(epoch FROM max(time)) * 1000 FROM index_daily WHERE symbol = $1)::float8 AS last_daily,
              (SELECT extract(epoch FROM min(bucket)) * 1000 FROM market_1d WHERE symbol = $1)::float8 AS first_agg,
              (SELECT to_char(min(bucket) AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM market_1d WHERE symbol = $1) AS first_agg_day,
              (SELECT array_agg(to_char(bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD')) FROM market_1d
                WHERE symbol = $1 AND bucket >= now() - make_interval(days => $2)) AS agg_days,
              (SELECT array_agg(to_char(time AT TIME ZONE 'UTC', 'YYYY-MM-DD')) FROM index_daily
                WHERE symbol = $1 AND time >= now() - make_interval(days => $2)) AS daily_days`,
      [symbol, GAP_LOOKBACK_DAYS + 1]
    );
    const now = Date.now();
    const seam = historyKeys.has(symbol) && needsDailyHistory(state?.last_daily ?? null, state?.first_agg ?? null, now);
    const gaps = missingWeekdays(state?.agg_days ?? [], state?.daily_days ?? [], state?.first_agg_day ?? null, now);
    const gapDue = gaps.length > 0 && now - (lastGapFetchAt.get(symbol) ?? 0) >= GAP_REFETCH_MS;
    if (!seam && !gapDue) continue;
    if (gapDue) lastGapFetchAt.set(symbol, now);
    try {
      const allRows = toDailyRows(await fetchBars(symbol, '1d', 366), now);
      // 이음매 채우기는 1년치 전부(이미 있는 날짜는 건너뜀), 빠진 날 메우기는 그 날짜만 넣는다(집계가 있는 날의 중복 행을 만들지 않음)
      const gapSet = new Set(gaps);
      const rows = seam ? allRows : allRows.filter(row => gapSet.has(new Date(row.time).toISOString().slice(0, 10)));
      await sendDailyRows(producer, symbol, rows, false);
      console.log(seam
        ? `Daily history backfill ${symbol}: ${rows.length} days sent`
        : `Daily gap fill ${symbol}: missing ${gaps.join(',')} → ${rows.length} sent (others not provided by the source, e.g. holidays)`);
    } catch (error) {
      console.error(`Daily history backfill ${symbol} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// 공식 종가 보정 (docs/Task_ORDER.md T-136, D-81)
// 장 시간이 정해진 시장의 지표(국내·미국·도쿄·대만)는 그 시장의 장이 끝나고 30분 뒤(T-145) 한 번, 최근 10일 Yahoo 일봉(공식 종가)을 index_daily에 넣는다.
// 이미 있는 Yahoo 일봉은 새 값으로 바꾼다(이전에 들어간 값이 확정 전이었을 수 있음). KRX 일봉(source 'krx', 코스피 200)은 건드리지 않는다.
// 아직 끝나지 않은 장의 봉은 넣지 않는다(toDailyRows). 집계(market_1d)는 다시 계산하지 않는다(저장 불변 조건).
// 받지 못한 지표는 다음 확인(30분 뒤) 때 다시 시도한다.
const lastCloseFixAt = new Map<YahooSymbolKey, number>();

export async function runOfficialCloseRefresh(producer: Producer) {
  const startedAt = Date.now();
  let calls = 0;
  let sent = 0;
  for (const symbol of YAHOO_KEYS) {
    if (!usesOfficialDailyClose(symbol)) continue;
    const now = Date.now();
    const sessionEnd = latestSessionEnd(YAHOO_MARKET[symbol], now, CLOSE_FIX_MARGIN_MS);
    if (sessionEnd === null || !shouldRefreshClose(lastCloseFixAt.get(symbol), sessionEnd)) continue;
    calls += 1;
    try {
      // 등락 계산에 직전 봉이 하나 더 필요해 하루 더 받는다
      const rows = toDailyRows(await fetchBars(symbol, '1d', CLOSE_FIX_DAYS + 1), now, sessionEnd + CLOSE_FIX_MARGIN_MS);
      await sendDailyRows(producer, symbol, rows, true);
      sent += rows.length;
      lastCloseFixAt.set(symbol, now);
      officialCloseLastSuccess.set({ symbol }, Math.floor(now / 1000));
    } catch (error) {
      console.error(`Official close refresh ${symbol} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (calls > 0) console.log(`Official close refresh: ${calls} symbols fetched, ${sent} daily rows sent (last ${CLOSE_FIX_DAYS} days) in ${Date.now() - startedAt}ms`);
}
