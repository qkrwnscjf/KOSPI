import type { Pool } from 'pg';
import { safeLogText } from '../http-json.js';
import { runChecks, type DqResult, type QueryFn } from './data-quality.js';

// 품질 검사 검증 (docs/BENCHMARK.md B-62 기준 4, 스위치 DQ_TEST_INJECT=true일 때만, 기본 끔)
// 트랜잭션 안에서 이상 데이터를 넣고 검사를 돌린 뒤 항상 ROLLBACK한다. 커밋하는 경로가 없어 실제 데이터와 집계는 바뀌지 않는다.
// 표 이름과 값은 모두 이 파일의 고정 문장이고 외부 입력이 없다.

const WINDOW_DAYS = `time >= now() - INTERVAL '10 days' AND time < now() - INTERVAL '3 days'`;
const RECENT = `time >= now() - INTERVAL '14 days'`;
const CAPITAL = `ARRAY['dilution', 'shareholder_return', 'treasury_disposal']`;
const runRow = (source: string, endpoint: string, received: number, dropped: number, status: string, total: string, covered: string) =>
  `INSERT INTO ingestion_runs (started_at, finished_at, run_id, source, endpoint, received, sent, dropped_total, dropped, status, source_total, covered)
   VALUES (now(), now(), gen_random_uuid(), '${source}', '${endpoint}', ${received}, 0, ${dropped}, '{}'::jsonb, '${status}', ${total}, ${covered})`;

const INJECTIONS: { target: string; sql: string[] }[] = [
  { target: 'yahoo_quote/future_time', sql: [`INSERT INTO market_ticks (time, symbol, category, price, change_rate, change_price) VALUES (now() + INTERVAL '1 hour', 'DQ_TEST', 'macro', 100, 0, 0)`] },
  { target: 'yahoo_quote/price_jump', sql: [`INSERT INTO market_ticks (time, symbol, category, price, change_rate, change_price) VALUES (now() - INTERVAL '20 minutes', 'DQ_JUMP', 'macro', 100, 0, 0), (now() - INTERVAL '19 minutes', 'DQ_JUMP', 'macro', 200, 0, 0)`] },
  { target: 'yahoo_quote/rate_consistency', sql: [`INSERT INTO market_ticks (time, symbol, category, price, change_rate, change_price) VALUES (now() - INTERVAL '18 minutes', 'DQ_RATE', 'macro', 100, 5, 50)`] },
  { target: 'yahoo_quote/freshness', sql: [`DELETE FROM market_ticks WHERE symbol = 'USD/KRW'`] },
  { target: 'yahoo_chart/date_label', sql: [`INSERT INTO index_daily_yahoo (time, symbol, close, change_rate, change_price) VALUES (date_trunc('week', now()) - INTERVAL '2 days' + INTERVAL '6 hours 30 minutes', 'SP500', 100, 0, 0) ON CONFLICT (symbol, time) DO NOTHING`] },
  { target: 'yahoo_chart/date_shift', sql: [
    `UPDATE index_daily_yahoo y SET close = a.prev
     FROM (SELECT bucket, lag(close) OVER (ORDER BY bucket) AS prev FROM market_1d WHERE symbol = 'DOW' AND bucket >= now() - INTERVAL '21 days') a
     WHERE y.symbol = 'DOW' AND y.time >= now() - INTERVAL '14 days' AND a.bucket = time_bucket(INTERVAL '1 day', y.time) AND a.prev IS NOT NULL`,
  ] },
  { target: 'yahoo_chart/close_missing', sql: [`DELETE FROM index_daily_yahoo WHERE symbol = 'NIKKEI' AND time >= now() - INTERVAL '6 days'`] },
  { target: 'yahoo_chart/daily_jump', sql: [`UPDATE index_daily_yahoo SET change_rate = 50 WHERE symbol = 'SOX' AND ${RECENT}`] },
  { target: 'krx_index/missing_days', sql: [`DELETE FROM index_daily_krx WHERE symbol = 'KRX_SEMI' AND ${WINDOW_DAYS}`] },
  { target: 'krx_index/cross_source', sql: [`UPDATE index_daily_yahoo SET close = close * 1.01 WHERE symbol = 'SAMSUNG' AND ${RECENT}`] },
  { target: 'krx_index/daily_jump', sql: [`UPDATE index_daily_krx SET change_rate = 50 WHERE symbol = 'KRX_BANK' AND ${RECENT}`] },
  { target: 'krx_stock/breadth_sum', sql: [`UPDATE market_breadth SET stocks = stocks + 1 WHERE market = 'KOSPI' AND ${RECENT}`] },
  { target: 'krx_stock/breadth_missing', sql: [`DELETE FROM market_breadth WHERE market = 'KOSDAQ' AND ${WINDOW_DAYS}`] },
  { target: 'krx_stock/rankings_missing', sql: [`DELETE FROM stock_rankings WHERE market = 'KOSDAQ' AND ${WINDOW_DAYS}`] },
  { target: 'krx_stock/rankings_contiguous', sql: [`UPDATE stock_rankings SET rank_cap = NULL WHERE market = 'KOSPI' AND rank_cap = 5 AND ${RECENT}`] },
  { target: 'kofia/metric_complete', sql: [`DELETE FROM market_flows WHERE metric = 'capital.invrDpsgAmt' AND time >= now() - INTERVAL '25 days' AND time < now() - INTERVAL '10 days'`] },
  { target: 'kofia/publish_lag', sql: [`DELETE FROM market_flows WHERE time >= now() - INTERVAL '8 days'`] },
  { target: 'dart/source_coverage', sql: [runRow('dart', 'list.json', 90, 0, 'ok', '100', '90')] },
  { target: 'dart/amount_fill', sql: [`UPDATE disclosures SET amount = NULL WHERE rcept_date >= current_date - 90 AND event_group = ANY(${CAPITAL})`] },
  { target: 'ingestion/run_recent', sql: [`DELETE FROM ingestion_runs WHERE source = 'kofia'`] },
  { target: 'ingestion/run_errors', sql: [...Array.from({ length: 10 }, () => runRow('krx_stock', 'test', 0, 0, 'error', 'NULL', 'NULL'))] },
  { target: 'ingestion/drop_ratio', sql: [runRow('krx_index', 'test', 100, 50, 'ok', 'NULL', 'NULL')] },
  { target: 'db/retention_overdue', sql: [`INSERT INTO index_daily_yahoo (time, symbol, close, change_rate, change_price) VALUES (now() - INTERVAL '2 years', 'DOW', 100, 0, 0)`] },
];

const keyOf = (result: DqResult) => `${result.dataset}/${result.check}`;

// 같은 트랜잭션 안에서 검사가 전과 달라졌는지 비교한다
export function detected(before: readonly DqResult[], after: readonly DqResult[], target: string) {
  const previous = before.find(result => keyOf(result) === target);
  const current = after.find(result => keyOf(result) === target);
  if (!current) return false;
  return current.status !== 'ok' && (previous?.status !== current.status || previous?.observed !== current.observed);
}

const COUNT_TABLES = ['index_daily_krx', 'index_daily_yahoo', 'market_breadth', 'stock_rankings', 'market_flows', 'disclosures'];

export async function runDqInjection(pool: Pool) {
  const count = async () => {
    const { rows } = await pool.query(COUNT_TABLES.map(name => `SELECT '${name}' AS name, count(*)::int AS n FROM ${name}`).join(' UNION ALL '));
    return Object.fromEntries(rows.map(row => [row.name, row.n])) as Record<string, number>;
  };
  const rowsBefore = await count();
  const client = await pool.connect();
  const query: QueryFn = (sql, params) => client.query(sql, params as unknown[]);
  const applied: string[] = [];
  const failed: string[] = [];
  let hits: string[] = [];
  let misses: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    const before = await runChecks(query);
    for (const { target, sql } of INJECTIONS) {
      try {
        await client.query('SAVEPOINT inject');
        for (const statement of sql) await client.query(statement);
        await client.query('RELEASE SAVEPOINT inject');
        applied.push(target);
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT inject');
        failed.push(`${target}:${safeLogText(error instanceof Error ? error.message : 'unexpected_error', 80)}`);
      }
    }
    const after = await runChecks(query);
    hits = applied.filter(target => detected(before, after, target));
    misses = applied.filter(target => !hits.includes(target));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  const rowsAfter = await count();
  console.log(`[dq-inject] ${JSON.stringify({ injected: applied.length, detected: hits.length, misses, failed, rowsBefore, rowsAfter })}`);

  // index_daily 분리 확인 (B-62 기준 2): 옛 표의 모든 행이 뷰에 있는지, 값이 다른 행은 어느 지표·날짜인지. 시세는 공개 값이다
  const { rows: [split] } = await pool.query(
    `SELECT (SELECT count(*)::int FROM index_daily_legacy) AS legacy,
            (SELECT count(*)::int FROM index_daily_legacy WHERE source = 'krx') AS legacy_krx,
            (SELECT count(*)::int FROM index_daily_legacy WHERE source = 'yahoo') AS legacy_yahoo,
            (SELECT count(*)::int FROM index_daily_krx WHERE ingested_at IS NULL) AS moved_krx,
            (SELECT count(*)::int FROM index_daily_yahoo WHERE ingested_at IS NULL) AS moved_yahoo,
            (SELECT count(*)::int FROM index_daily_legacy l WHERE NOT EXISTS (SELECT 1 FROM index_daily v WHERE v.symbol = l.symbol AND v.time = l.time)) AS missing,
            (SELECT count(*)::int FROM (SELECT symbol, time FROM index_daily GROUP BY symbol, time HAVING count(*) > 1) d) AS duplicated`
  );
  const { rows: changed } = await pool.query(
    `SELECT l.symbol, to_char(l.time AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS day, l.close AS old_close, v.close AS new_close, v.source
     FROM index_daily_legacy l JOIN index_daily v ON v.symbol = l.symbol AND v.time = l.time
     WHERE abs(l.close - v.close) > 0.000001 ORDER BY day DESC LIMIT 20`
  );
  console.log(`[split-check] ${JSON.stringify({ ...split, changedSample: changed })}`);
}
