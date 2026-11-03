import { kafka, TOPICS, ensureTopics, sendToDlq } from '../kafka.js';
import { dbPool } from '../db.js';
import { Counter, Gauge, Latency, metricsConfig, startMetricsLog, startMetricsServer } from '../metrics.js';
import { parseTick } from '../../shared/tick-validation.js';
import type { TickData } from '../../shared/types.js';
import { parseInvestorFlow, type InvestorFlow } from '../../shared/flows.js';
import { parseDisclosure, type Disclosure } from '../../shared/disclosures.js';
import { isKrxDailySymbol, isKrxHistorySymbol } from '../../shared/krx-indices.js';
import { parseMarketBreadth, type MarketBreadth } from '../../shared/breadth.js';
import { parseStockRankings, type StockRankings } from '../../shared/rankings.js';
import { parseMarketFlow, type MarketFlow } from '../../shared/market-flows.js';
import { parseYahooDaily, type YahooDailyMessage } from '../../shared/yahoo-daily.js';
import { YAHOO_DAILY_SOURCE } from '../../shared/symbols.js';
import { setWallClockTimeout } from '../wall-clock-timer.js';
import type { EachBatchPayload } from 'kafkajs';
import { runBackfillOnce, runDailyHistoryBackfill, runOfficialCloseRefresh } from './backfill.js';
import { clampWindow, mergeWindows, planLateRefresh, POLICY_START_OFFSET_MS, SAFE_RAW_WINDOW_MS, type RefreshWindow } from './late-refresh.js';
import { runDlqReplay } from './dlq-replay.js';
import { registerShutdown } from '../shutdown.js';

// DB 적재 컨슈머 (docs/Task_ORDER.md T-12, D-18)
// worker 대신 Kafka의 market-ticks를 읽어 TimescaleDB에 저장한다. Kafka가 단일 출처가 된다.
// 저장에 성공한 뒤에만 오프셋을 커밋하므로, DB가 멈춰도 데이터를 잃지 않는다 (at-least-once).

const GROUP_ID = 'db-sink';
const CONSUMER_NAME = 'db-sink';

const consumer = kafka.consumer({ groupId: GROUP_ID });
const dlqProducer = kafka.producer();

// 측정 지표
const rowsInsertedTotal = new Counter('kospi_sink_rows_inserted_total', 'Rows inserted into TimescaleDB by the DB sink');
const invalidTotal = new Counter('kospi_sink_invalid_messages_total', 'Messages sent to the DLQ by the DB sink, by reason');
const insertDuration = new Latency('kospi_sink_insert_duration_seconds', 'Batch INSERT duration by result (commit / error)');
const batchesTotal = new Counter('kospi_sink_batches_total', 'Batch INSERTs committed (average batch size = rows_inserted_total / batches_total)');
const storeLatency = new Latency('kospi_sink_store_latency_seconds', 'Worker collection to DB commit (M-03 equivalent for the storage path)');
// 중복 차단 (docs/Task_ORDER.md T-15): 같은 (symbol, time)이 이미 있으면 DB가 건너뛴다
const duplicatesSkippedTotal = new Counter('kospi_sink_duplicates_skipped_total', 'Rows skipped by ON CONFLICT (symbol, time) DO NOTHING');
// DB 용량 (BENCHMARK B-07)
const dbSizeBytes = new Gauge('kospi_db_size_bytes', 'Size of the raw hypertable and each continuous aggregate in bytes');
const dbChunks = new Gauge('kospi_db_chunks', 'Number of chunks of the raw hypertable and each continuous aggregate (T-31)');
// 보관·갱신 작업 상태 (docs/Task_ORDER.md T-48). 원본이 3시간보다 오래 남는 원인을 확인하기 위함 (B-21 관찰)
const dbJobSchedule = new Gauge('kospi_db_job_schedule_seconds', 'Schedule interval of TimescaleDB retention / refresh jobs');
const dbJobLastSuccessAge = new Gauge('kospi_db_job_last_success_age_seconds', 'Seconds since the last successful run of each TimescaleDB job');
const dbJobFailures = new Gauge('kospi_db_job_failures', 'Total failures of each TimescaleDB job');
const dbRawOldestAge = new Gauge('kospi_db_raw_oldest_age_seconds', 'Age of the oldest row in market_ticks (raw retention target: 3h, D-02)');
const DB_SIZE_INTERVAL_MS = 5 * 60 * 1000;
const DAILY_HISTORY_INTERVAL_MS = 6 * 60 * 60 * 1000;
// 11단계·12단계·T-67에서 추가한 테이블 (용량·청크·행 수 기록). 이름은 고정 목록이고 매개변수로만 SQL에 넘긴다.
const EXTRA_TABLES = ['investor_flows', 'index_daily', 'disclosures', 'market_breadth', 'stock_rankings', 'market_flows'];
const dbRows = new Gauge('kospi_db_rows', 'Row count of the smaller hypertables added in stages 11-12 (investor_flows, index_daily, disclosures)');

// 여러 행을 INSERT 한 번으로 저장한다 (P-16). 단일 문장이라 전부 들어가거나 전부 실패한다.
// 실제로 들어간 행 수와, 들어간 행의 시각들(늦은 데이터 보정용, T-128)을 돌려준다.
// 나머지는 유니크 제약에 걸려 건너뛴 중복이다 (T-15). 중복은 이미 집계에 반영된 값이라 보정 대상이 아니다.
async function insertBatch(ticks: TickData[]) {
  const values: unknown[] = [];
  const rows = ticks.map((tick, index) => {
    const base = index * 7;
    values.push(tick.timestamp, tick.symbol, tick.category, tick.price, tick.changeRate, tick.changePrice, tick.volume ?? null);
    return `(to_timestamp($${base + 1} / 1000.0), $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });
  const result = await dbPool.query<{ ms: number }>(
    `INSERT INTO market_ticks (time, symbol, category, price, change_rate, change_price, volume) VALUES ${rows.join(', ')}
     ON CONFLICT (symbol, time) DO NOTHING
     RETURNING (extract(epoch FROM time) * 1000)::float8 AS ms`,
    values
  );
  return { inserted: result.rowCount ?? 0, times: result.rows.map(row => row.ms) };
}

// 늦은 데이터 보정 (T-128): 정책 범위(최근 2시간) 밖에 새로 저장된 원본이 있으면 그 구간의 5분 봉만 다시 계산한다.
// 묶음마다 바로 부르지 않고 30초 동안 구간을 합쳐서 한 번 부른다(밀린 메시지를 따라잡는 동안 수백 번 부르지 않게).
const lateRowsTotal = new Counter('kospi_sink_late_rows_total', 'Raw ticks stored outside the 5m refresh window, by recoverable (yes = re-aggregated, no = older than the safe raw window)');
const lateRefreshTotal = new Counter('kospi_sink_late_refresh_total', 'Manual 5m aggregate refreshes for late raw ticks, by result');
const LATE_REFRESH_DELAY_MS = 30_000;
let pendingLateWindow: RefreshWindow | null = null;
let lateRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let lastUnrecoverableWarnAt = 0;

function scheduleLateRefresh(insertedTimes: number[]) {
  if (insertedTimes.length === 0) return;
  const nowMs = Date.now();
  const oldestInsertedMs = Math.min(...insertedTimes);
  const { window, unrecoverable } = planLateRefresh(oldestInsertedMs, nowMs);
  if (!window && !unrecoverable) return;
  const safeStart = nowMs - SAFE_RAW_WINDOW_MS;
  const policyStart = nowMs - POLICY_START_OFFSET_MS;
  const tooOld = insertedTimes.filter(ms => ms < safeStart).length;
  const late = insertedTimes.filter(ms => ms < policyStart).length;
  if (late - tooOld > 0) lateRowsTotal.inc({ recoverable: 'yes' }, late - tooOld);
  if (tooOld > 0) lateRowsTotal.inc({ recoverable: 'no' }, tooOld);
  // 장이 닫힌 시간에 worker가 다시 시작하면 지표마다 마지막 tick(몇 시간 전)을 다시 보내서 여기에 걸린다(B-22, 무해). 경고는 10분에 한 번만
  if (unrecoverable && Date.now() - lastUnrecoverableWarnAt > 10 * 60_000) {
    lastUnrecoverableWarnAt = Date.now();
    console.warn(`DB sink stored raw ticks older than the safe re-aggregation window (oldest ${new Date(oldestInsertedMs).toISOString()}); those 5m buckets cannot be rebuilt (daily gap fill covers the 1d view)`);
  }
  if (!window) return;
  pendingLateWindow = mergeWindows(pendingLateWindow, window);
  if (lateRefreshTimer) return;
  lateRefreshTimer = setTimeout(() => {
    lateRefreshTimer = undefined;
    const planned = pendingLateWindow;
    pendingLateWindow = null;
    void runLateRefresh(planned);
  }, LATE_REFRESH_DELAY_MS);
}

async function runLateRefresh(planned: RefreshWindow | null) {
  const window = planned ? clampWindow(planned, Date.now()) : null;
  if (!window) {
    lateRefreshTotal.inc({ result: 'skipped_unsafe' });
    return;
  }
  const startedAt = Date.now();
  try {
    // 집계 이름은 고정값, 시각은 코드가 만든 ISO 문자열이다(외부 입력 없음). 연속 집계 갱신은 트랜잭션 밖에서만 된다.
    await dbPool.query(`CALL refresh_continuous_aggregate('market_5m', '${new Date(window.start).toISOString()}'::timestamptz, '${new Date(window.end).toISOString()}'::timestamptz)`);
    lateRefreshTotal.inc({ result: 'ok' });
    console.log(`DB sink re-aggregated market_5m for late ticks ${new Date(window.start).toISOString()} ~ ${new Date(window.end).toISOString()} in ${Date.now() - startedAt}ms`);
  } catch (error) {
    lateRefreshTotal.inc({ result: 'error' });
    console.error(`DB sink late re-aggregation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 증시 자금 흐름 저장 (docs/Task_ORDER.md 11단계 A, D-47)
// 같은 (market, time)이면 덮어쓰되, 이미 확정치(final)인 행은 잠정치(provisional)로 되돌리지 않는다.
const flowRowsUpserted = new Counter('kospi_sink_flow_rows_upserted_total', 'Investor flow rows inserted or updated');

async function upsertFlows(flows: InvestorFlow[]) {
  const values: unknown[] = [];
  const rows = flows.map((flow, index) => {
    const base = index * 7;
    values.push(flow.time, flow.market, flow.foreignNet, flow.institutionNet, flow.individualNet, flow.status, flow.source);
    return `(to_timestamp($${base + 1} / 1000.0), $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });
  const result = await dbPool.query(
    `INSERT INTO investor_flows (time, market, foreign_net, institution_net, individual_net, status, source) VALUES ${rows.join(', ')}
     ON CONFLICT (market, time) DO UPDATE SET
       foreign_net = EXCLUDED.foreign_net,
       institution_net = EXCLUDED.institution_net,
       individual_net = EXCLUDED.individual_net,
       status = EXCLUDED.status,
       source = EXCLUDED.source
     WHERE investor_flows.status <> 'final' OR EXCLUDED.status = 'final'`,
    values
  );
  return result.rowCount ?? 0;
}

// 증시 자금 흐름 묶음 처리. 시세 묶음 처리와 같은 규칙: 잘못된 메시지는 DLQ, 저장에 성공한 뒤에만 오프셋 확정.
async function handleFlowsBatch({ batch, resolveOffset, heartbeat }: EachBatchPayload) {
  const valid: InvestorFlow[] = [];
  for (const message of batch.messages) {
    const parsed = parseInvestorFlow(message.value);
    if (!parsed.ok) {
      invalidTotal.inc({ reason: `flow_${parsed.reason}` });
      console.warn(`DB sink skipped invalid flow message at ${batch.topic}[${batch.partition}]@${message.offset}: ${parsed.reason}`);
      await sendToDlq(dlqProducer, { consumer: CONSUMER_NAME, topic: batch.topic, partition: batch.partition, message, reason: parsed.reason });
      continue;
    }
    valid.push(parsed.flow);
  }
  if (valid.length > 0) {
    // 예외는 그대로 던져서 오프셋을 확정하지 않는다 (kafkajs가 다시 시도)
    flowRowsUpserted.inc({}, await upsertFlows(valid));
  }
  const lastMessage = batch.messages[batch.messages.length - 1];
  if (lastMessage) resolveOffset(lastMessage.offset);
  await heartbeat();
}

// KRX 일별 지수 저장 (docs/Task_ORDER.md T-67). 같은 (symbol, time)이면 최신 값으로 덮어쓴다(정정 반영).
const indexDailyRowsUpserted = new Counter('kospi_sink_index_daily_rows_upserted_total', 'KRX daily index rows inserted or updated');

async function upsertIndexDaily(ticks: TickData[]) {
  const values: unknown[] = [];
  const rows = ticks.map((tick, index) => {
    const base = index * 5;
    values.push(tick.timestamp, tick.symbol, tick.price, tick.changeRate, tick.changePrice ?? null);
    return `(to_timestamp($${base + 1} / 1000.0), $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, 'krx')`;
  });
  const result = await dbPool.query(
    `INSERT INTO index_daily (time, symbol, close, change_rate, change_price, source) VALUES ${rows.join(', ')}
     ON CONFLICT (symbol, time) DO UPDATE SET
       close = EXCLUDED.close, change_rate = EXCLUDED.change_rate, change_price = EXCLUDED.change_price`,
    values
  );
  return result.rowCount ?? 0;
}

// DART 공시 저장 (12단계 T-76). 같은 접수번호면 내용을 갱신하되, 금액은 새 값이 없으면 기존 값을 유지하고
// 처음 본 시각(first_seen_at)은 바꾸지 않는다.
const disclosureRowsUpserted = new Counter('kospi_sink_disclosure_rows_upserted_total', 'DART disclosure rows inserted or updated');

async function upsertDisclosures(items: Disclosure[]) {
  const values: unknown[] = [];
  const rows = items.map((item, index) => {
    const base = index * 11;
    values.push(item.rceptDate, item.rceptNo, item.corpCode, item.stockCode, item.corpName, item.reportName,
      item.group, item.kind, item.isCorrection, item.amount, item.market);
    return `($${base + 1}::date, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
  });
  const result = await dbPool.query(
    `INSERT INTO disclosures (rcept_date, rcept_no, corp_code, stock_code, corp_name, report_name, event_group, event_kind, is_correction, amount, market)
     VALUES ${rows.join(', ')}
     ON CONFLICT (rcept_no, rcept_date) DO UPDATE SET
       corp_name = EXCLUDED.corp_name, report_name = EXCLUDED.report_name,
       event_group = EXCLUDED.event_group, event_kind = EXCLUDED.event_kind, is_correction = EXCLUDED.is_correction,
       amount = COALESCE(EXCLUDED.amount, disclosures.amount)`,
    values
  );
  return result.rowCount ?? 0;
}

// 한 묶음 안에 같은 키가 두 번 있으면 ON CONFLICT DO UPDATE가 실패하므로 마지막 값만 남긴다
const lastByKey = <T>(items: T[], keyOf: (item: T) => string) => [...new Map(items.map(item => [keyOf(item), item])).values()];

// KRX 일별 지수·DART 공시 묶음 처리. 시세 묶음 처리와 같은 규칙: 잘못된 메시지는 DLQ, 저장에 성공한 뒤에만 오프셋 확정.
async function handleDailyBatch({ batch, resolveOffset, heartbeat }: EachBatchPayload) {
  const isIndex = batch.topic === TOPICS.indexDaily;
  const ticks: TickData[] = [];
  const disclosures: Disclosure[] = [];
  for (const message of batch.messages) {
    let reason: string | undefined;
    if (isIndex) {
      const parsed = parseTick(message.value);
      if (!parsed.ok) reason = parsed.reason;
      // KRX 일별 지수와, Yahoo 지표의 과거 일봉을 KRX에서 받은 것(T-104 보완, 코스피 200)만 받는다
      else if (!isKrxDailySymbol(parsed.tick.symbol) && !isKrxHistorySymbol(parsed.tick.symbol)) reason = 'not_daily_symbol';
      else ticks.push(parsed.tick);
    } else {
      const parsed = parseDisclosure(message.value);
      if (!parsed.ok) reason = parsed.reason;
      else disclosures.push(parsed.disclosure);
    }
    if (reason) {
      invalidTotal.inc({ reason: `${isIndex ? 'index' : 'disclosure'}_${reason}` });
      console.warn(`DB sink skipped invalid message at ${batch.topic}[${batch.partition}]@${message.offset}: ${reason}`);
      await sendToDlq(dlqProducer, { consumer: CONSUMER_NAME, topic: batch.topic, partition: batch.partition, message, reason });
    }
  }
  // 예외는 그대로 던져서 오프셋을 확정하지 않는다 (kafkajs가 다시 시도)
  if (ticks.length > 0) indexDailyRowsUpserted.inc({}, await upsertIndexDaily(lastByKey(ticks, tick => `${tick.symbol}|${tick.timestamp}`)));
  for (let index = 0; index < disclosures.length; index += 500) {
    const chunk = lastByKey(disclosures.slice(index, index + 500), item => item.rceptNo);
    disclosureRowsUpserted.inc({}, await upsertDisclosures(chunk));
  }
  const lastMessage = batch.messages[batch.messages.length - 1];
  if (lastMessage) resolveOffset(lastMessage.offset);
  await heartbeat();
}

// 시장 폭·거래대금 저장 (docs/Task_ORDER.md T-106). 같은 (market, time)이면 최신 값으로 덮어쓴다(정정 반영).
const breadthRowsUpserted = new Counter('kospi_sink_breadth_rows_upserted_total', 'Market breadth rows inserted or updated');

async function upsertBreadth(items: MarketBreadth[]) {
  const values: unknown[] = [];
  const rows = items.map((item, index) => {
    const base = index * 7;
    values.push(item.time, item.market, item.advancers, item.decliners, item.unchanged, item.stocks, item.tradingValue);
    return `(to_timestamp($${base + 1} / 1000.0), $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, 'krx')`;
  });
  const result = await dbPool.query(
    `INSERT INTO market_breadth (time, market, advancers, decliners, unchanged, stocks, trading_value, source) VALUES ${rows.join(', ')}
     ON CONFLICT (market, time) DO UPDATE SET
       advancers = EXCLUDED.advancers, decliners = EXCLUDED.decliners, unchanged = EXCLUDED.unchanged,
       stocks = EXCLUDED.stocks, trading_value = EXCLUDED.trading_value`,
    values
  );
  return result.rowCount ?? 0;
}

// 시장 폭 묶음 처리. 다른 토픽과 같은 규칙: 잘못된 메시지는 DLQ, 저장에 성공한 뒤에만 오프셋 확정.
async function handleBreadthBatch({ batch, resolveOffset, heartbeat }: EachBatchPayload) {
  const valid: MarketBreadth[] = [];
  for (const message of batch.messages) {
    const parsed = parseMarketBreadth(message.value);
    if (!parsed.ok) {
      invalidTotal.inc({ reason: `breadth_${parsed.reason}` });
      console.warn(`DB sink skipped invalid breadth message at ${batch.topic}[${batch.partition}]@${message.offset}: ${parsed.reason}`);
      await sendToDlq(dlqProducer, { consumer: CONSUMER_NAME, topic: batch.topic, partition: batch.partition, message, reason: parsed.reason });
      continue;
    }
    valid.push(parsed.breadth);
  }
  // 예외는 그대로 던져서 오프셋을 확정하지 않는다 (kafkajs가 다시 시도)
  if (valid.length > 0) breadthRowsUpserted.inc({}, await upsertBreadth(lastByKey(valid, item => `${item.market}|${item.time}`)));
  const lastMessage = batch.messages[batch.messages.length - 1];
  if (lastMessage) resolveOffset(lastMessage.offset);
  await heartbeat();
}

// 종목 순위 저장 (T-113). 시장·날짜 단위로 통째로 바꾼다(다시 받은 날 순위에서 빠진 종목이 남지 않게).
// 지우기와 넣기를 한 트랜잭션으로 해서, 실패하면 이전 순위가 그대로 남는다.
const rankingRowsReplaced = new Counter('kospi_sink_ranking_rows_replaced_total', 'Stock ranking rows written (each market-day is replaced as a whole)');

async function replaceRankings(item: StockRankings) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM stock_rankings WHERE market = $1 AND time = to_timestamp($2 / 1000.0)`, [item.market, item.time]);
    const values: unknown[] = [item.time, item.market];
    const rows = item.entries.map((entry, index) => {
      const base = 2 + index * 10;
      values.push(entry.code, entry.name, entry.close, entry.changeRate, entry.tradingValue, entry.marketCap,
        entry.ranks.gain ?? null, entry.ranks.loss ?? null, entry.ranks.value ?? null, entry.ranks.cap ?? null);
      return `(to_timestamp($1 / 1000.0), $2, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, 'krx')`;
    });
    const result = await client.query(
      `INSERT INTO stock_rankings (time, market, code, name, close, change_rate, trading_value, market_cap, rank_gain, rank_loss, rank_value, rank_cap, source)
       VALUES ${rows.join(', ')}`,
      values
    );
    await client.query('COMMIT');
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// 종목 순위 묶음 처리. 다른 토픽과 같은 규칙: 잘못된 메시지는 DLQ, 저장에 성공한 뒤에만 오프셋 확정.
async function handleRankingsBatch({ batch, resolveOffset, heartbeat }: EachBatchPayload) {
  const valid: StockRankings[] = [];
  for (const message of batch.messages) {
    const parsed = parseStockRankings(message.value);
    if (!parsed.ok) {
      invalidTotal.inc({ reason: `rankings_${parsed.reason}` });
      console.warn(`DB sink skipped invalid rankings message at ${batch.topic}[${batch.partition}]@${message.offset}: ${parsed.reason}`);
      await sendToDlq(dlqProducer, { consumer: CONSUMER_NAME, topic: batch.topic, partition: batch.partition, message, reason: parsed.reason });
      continue;
    }
    valid.push(parsed.rankings);
  }
  // 같은 시장·날짜가 묶음에 두 번 있으면 마지막 것만. 예외는 그대로 던져서 오프셋을 확정하지 않는다
  for (const item of lastByKey(valid, entry => `${entry.market}|${entry.time}`)) {
    rankingRowsReplaced.inc({}, await replaceRankings(item));
    await heartbeat();
  }
  const lastMessage = batch.messages[batch.messages.length - 1];
  if (lastMessage) resolveOffset(lastMessage.offset);
  await heartbeat();
}

// 증시 자금 흐름 일별 통계 저장 (11단계 B′ T-97). 값마다 한 행(지표 '<데이터셋>.<필드>'), 같은 (metric, time)이면 최신 값으로 덮어쓴다.
const marketFlowRowsUpserted = new Counter('kospi_sink_market_flow_rows_upserted_total', 'Market fund statistic rows (one per metric per day) inserted or updated');

async function upsertMarketFlows(flows: MarketFlow[]) {
  const rows = lastByKey(
    flows.flatMap(flow => Object.entries(flow.values).map(([field, value]) => ({ time: flow.time, metric: `${flow.dataset}.${field}`, value }))),
    row => `${row.metric}|${row.time}`
  );
  if (rows.length === 0) return 0;
  const values: unknown[] = [];
  const placeholders = rows.map((row, index) => {
    const base = index * 3;
    values.push(row.time, row.metric, row.value);
    return `(to_timestamp($${base + 1} / 1000.0), $${base + 2}, $${base + 3}, 'kofia')`;
  });
  const result = await dbPool.query(
    `INSERT INTO market_flows (time, metric, value, source) VALUES ${placeholders.join(', ')}
     ON CONFLICT (metric, time) DO UPDATE SET value = EXCLUDED.value`,
    values
  );
  return result.rowCount ?? 0;
}

// 다른 토픽과 같은 규칙: 잘못된 메시지는 DLQ, 저장에 성공한 뒤에만 오프셋 확정.
async function handleMarketFlowsBatch({ batch, resolveOffset, heartbeat }: EachBatchPayload) {
  const valid: MarketFlow[] = [];
  for (const message of batch.messages) {
    const parsed = parseMarketFlow(message.value);
    if (!parsed.ok) {
      invalidTotal.inc({ reason: `market_flow_${parsed.reason}` });
      console.warn(`DB sink skipped invalid market flow message at ${batch.topic}[${batch.partition}]@${message.offset}: ${parsed.reason}`);
      await sendToDlq(dlqProducer, { consumer: CONSUMER_NAME, topic: batch.topic, partition: batch.partition, message, reason: parsed.reason });
      continue;
    }
    valid.push(parsed.flow);
  }
  // 예외는 그대로 던져서 오프셋을 확정하지 않는다 (kafkajs가 다시 시도)
  if (valid.length > 0) {
    const upserted = await upsertMarketFlows(valid);
    marketFlowRowsUpserted.inc({}, upserted);
    console.log(`DB sink stored market flows: ${valid.length} dataset-days, ${upserted} metric rows`);
  }
  const lastMessage = batch.messages[batch.messages.length - 1];
  if (lastMessage) resolveOffset(lastMessage.offset);
  await heartbeat();
}

// Yahoo 일봉 저장 (T-143). 빈 날 채우기는 없는 날짜만 넣고, 공식 종가 보정은 Yahoo 행만 새 값으로 바꾼다(KRX 행은 그대로, T-136).
const yahooDailyReceived = new Counter('kospi_sink_yahoo_daily_received_total', 'Valid Yahoo daily messages received from Kafka');
const yahooDailyWritten = new Counter('kospi_sink_yahoo_daily_rows_written_total', 'Yahoo daily rows inserted or updated in index_daily');

async function writeYahooDaily(rows: YahooDailyMessage[], overwrite: boolean) {
  if (rows.length === 0) return 0;
  const values: unknown[] = [];
  const placeholders = rows.map((row, index) => {
    const base = index * 6;
    values.push(row.time, row.symbol, row.close, row.changeRate, row.changePrice, YAHOO_DAILY_SOURCE);
    return `(to_timestamp($${base + 1} / 1000.0), $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });
  const conflict = overwrite
    ? `DO UPDATE SET close = EXCLUDED.close, change_rate = EXCLUDED.change_rate, change_price = EXCLUDED.change_price
       WHERE index_daily.source = EXCLUDED.source`
    : 'DO NOTHING';
  const result = await dbPool.query(
    `INSERT INTO index_daily (time, symbol, close, change_rate, change_price, source) VALUES ${placeholders.join(', ')}
     ON CONFLICT (symbol, time) ${conflict}`,
    values
  );
  return result.rowCount ?? 0;
}

// 다른 토픽과 같은 규칙: 잘못된 메시지는 DLQ, 저장에 성공한 뒤에만 오프셋 확정.
async function handleYahooDailyBatch({ batch, resolveOffset, heartbeat }: EachBatchPayload) {
  const valid: YahooDailyMessage[] = [];
  for (const message of batch.messages) {
    const parsed = parseYahooDaily(message.value);
    if (!parsed.ok) {
      invalidTotal.inc({ reason: `yahoo_daily_${parsed.reason}` });
      console.warn(`DB sink skipped invalid Yahoo daily message at ${batch.topic}[${batch.partition}]@${message.offset}: ${parsed.reason}`);
      await sendToDlq(dlqProducer, { consumer: CONSUMER_NAME, topic: batch.topic, partition: batch.partition, message, reason: parsed.reason });
      continue;
    }
    valid.push(parsed.row);
  }
  // 없는 날짜 넣기를 먼저, 바꾸기를 나중에 한다. 같은 묶음에 둘 다 있으면 공식 종가가 남는다. 예외는 그대로 던져서 오프셋을 확정하지 않는다
  if (valid.length > 0) {
    const keyOf = (row: YahooDailyMessage) => `${row.symbol}|${row.time}`;
    const written = await writeYahooDaily(lastByKey(valid.filter(row => !row.overwrite), keyOf), false)
      + await writeYahooDaily(lastByKey(valid.filter(row => row.overwrite), keyOf), true);
    yahooDailyReceived.inc({}, valid.length);
    yahooDailyWritten.inc({}, written);
    console.log(`DB sink stored Yahoo daily rows: ${valid.length} received, ${written} written`);
  }
  const lastMessage = batch.messages[batch.messages.length - 1];
  if (lastMessage) resolveOffset(lastMessage.offset);
  await heartbeat();
}

// 데이터 신선도 (15단계 T-112): 데이터셋마다 가장 최근 값이 얼마나 오래됐는지(초). 앱 설정 화면의 파이프라인 상태와 Grafana에 쓴다.
// 테이블 이름은 고정 목록이다. 비어 있는 데이터셋은 기록하지 않는다(값이 생긴 뒤부터 나타남).
const dataLatestAge = new Gauge('kospi_db_latest_data_age_seconds', 'Seconds since the newest row of each dataset (market_ticks, index_daily, market_breadth, disclosures, stock_rankings, market_flows)');

async function recordFreshness() {
  const { rows } = await dbPool.query<{ dataset: string; age_s: number | null }>(`
    SELECT 'market_ticks' AS dataset, extract(epoch FROM now() - max(time))::float8 AS age_s FROM market_ticks
    UNION ALL SELECT 'index_daily', extract(epoch FROM now() - max(time))::float8 FROM index_daily
    UNION ALL SELECT 'market_breadth', extract(epoch FROM now() - max(time))::float8 FROM market_breadth
    UNION ALL SELECT 'disclosures', extract(epoch FROM now() - max(first_seen_at))::float8 FROM disclosures
    UNION ALL SELECT 'stock_rankings', extract(epoch FROM now() - max(time))::float8 FROM stock_rankings
    UNION ALL SELECT 'market_flows', extract(epoch FROM now() - max(time))::float8 FROM market_flows
  `);
  for (const row of rows) {
    if (row.age_s !== null) dataLatestAge.set({ dataset: row.dataset }, Math.max(0, Math.round(row.age_s)));
  }
}

// 원본과 집계의 용량, 청크 수, 보관·갱신 작업 상태를 기록한다 (B-07, T-31, T-48). 조회 실패는 수집에 영향을 주지 않도록 로그만 남긴다.
async function recordDbSize() {
  try {
    const { rows } = await dbPool.query<{ relation: string; bytes: string }>(`
      SELECT 'market_ticks' AS relation, hypertable_size('market_ticks')::text AS bytes
      UNION ALL
      SELECT name AS relation, hypertable_size(name::regclass)::text AS bytes
      FROM unnest($1::text[]) AS name
      UNION ALL
      SELECT view_name::text AS relation,
             hypertable_size(format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)::regclass)::text AS bytes
      FROM timescaledb_information.continuous_aggregates
    `, [EXTRA_TABLES]);
    for (const row of rows) {
      dbSizeBytes.set({ relation: row.relation }, Number(row.bytes));
    }

    const chunks = await dbPool.query<{ relation: string; chunks: string }>(`
      SELECT name AS relation, count(c.chunk_name)::text AS chunks
      FROM unnest($1::text[]) AS name
      LEFT JOIN timescaledb_information.chunks c ON c.hypertable_name = name
      GROUP BY name
      UNION ALL
      SELECT ca.view_name::text AS relation, count(c.chunk_name)::text AS chunks
      FROM timescaledb_information.continuous_aggregates ca
      LEFT JOIN timescaledb_information.chunks c
        ON c.hypertable_schema = ca.materialization_hypertable_schema
       AND c.hypertable_name = ca.materialization_hypertable_name
      GROUP BY ca.view_name
    `, [['market_ticks', ...EXTRA_TABLES]]);
    for (const row of chunks.rows) {
      dbChunks.set({ relation: row.relation }, Number(row.chunks));
    }

    // 새 테이블은 행이 적어서(수만 행 이하) 정확한 행 수를 센다. 행당 용량을 계산해 1년 용량 추정에 쓴다.
    const counts = await dbPool.query<{ relation: string; rows: string }>(`
      SELECT 'investor_flows' AS relation, count(*)::text AS rows FROM investor_flows
      UNION ALL SELECT 'index_daily', count(*)::text FROM index_daily
      UNION ALL SELECT 'disclosures', count(*)::text FROM disclosures
      UNION ALL SELECT 'market_breadth', count(*)::text FROM market_breadth
      UNION ALL SELECT 'stock_rankings', count(*)::text FROM stock_rankings
      UNION ALL SELECT 'market_flows', count(*)::text FROM market_flows
    `);
    for (const row of counts.rows) {
      dbRows.set({ relation: row.relation }, Number(row.rows));
    }

    // 보관(retention)과 집계 갱신(refresh) 작업 (T-48). 집계 작업은 저장 테이블 대신 집계 이름으로 표시한다.
    const jobs = await dbPool.query<{ job: string; schedule_s: number; last_success_age_s: number | null; failures: number | null }>(`
      SELECT replace(j.proc_name, 'policy_', '') || ':' || COALESCE(ca.view_name::text, j.hypertable_name::text) AS job,
             extract(epoch FROM j.schedule_interval)::float8 AS schedule_s,
             extract(epoch FROM now() - s.last_successful_finish)::float8 AS last_success_age_s,
             s.total_failures::float8 AS failures
      FROM timescaledb_information.jobs j
      LEFT JOIN timescaledb_information.job_stats s ON s.job_id = j.job_id
      LEFT JOIN timescaledb_information.continuous_aggregates ca
        ON ca.materialization_hypertable_schema = j.hypertable_schema
       AND ca.materialization_hypertable_name = j.hypertable_name
      WHERE j.proc_name IN ('policy_retention', 'policy_refresh_continuous_aggregate')
    `);
    for (const row of jobs.rows) {
      dbJobSchedule.set({ job: row.job }, row.schedule_s);
      if (row.last_success_age_s !== null) dbJobLastSuccessAge.set({ job: row.job }, Math.round(row.last_success_age_s));
      if (row.failures !== null) dbJobFailures.set({ job: row.job }, row.failures);
    }

    const oldest = await dbPool.query<{ age_s: number | null }>(
      `SELECT extract(epoch FROM now() - min(time))::float8 AS age_s FROM market_ticks`
    );
    // 원본이 비어 있으면 0으로 기록한다 (값을 건너뛰면 이전 값이 남아 오래된 것처럼 보임).
    // 주의: worker가 다시 시작하면 지표마다 마지막 tick을 한 번 다시 보낸다. 장이 닫힌 시간에는 그 시각이 오래전이라
    // 다음 보관 작업(1시간 주기)까지 이 값이 커질 수 있다 (B-22).
    dbRawOldestAge.set({}, Math.round(oldest.rows[0]?.age_s ?? 0));
    await recordFreshness();
  } catch (error) {
    console.error(`DB size check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function run() {
  console.log('DB sink starting...');
  await dlqProducer.connect();
  await ensureTopics();
  await consumer.connect();
  // 그룹이 처음 시작할 때만 토픽의 처음부터 읽는다. 이후에는 커밋된 오프셋부터 이어서 읽는다.
  await consumer.subscribe({ topics: [TOPICS.ticks, TOPICS.flows, TOPICS.indexDaily, TOPICS.disclosures, TOPICS.breadth, TOPICS.rankings, TOPICS.marketFlows, TOPICS.yahooDaily], fromBeginning: true });

  // kafkajs가 스스로 재시작하지 않는 중단이면 종료해서 docker-compose의 restart: on-failure가 다시 띄우게 한다.
  consumer.on(consumer.events.CRASH, event => {
    console.error(`DB sink consumer crashed: ${event.payload.error.message} (restart: ${event.payload.restart})`);
    if (!event.payload.restart) process.exit(1);
  });

  startMetricsServer(metricsConfig.port);
  startMetricsLog('db-sink', metricsConfig.logIntervalMs);

  await consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: async payload => {
      // 토픽별로 나눠 처리한다 (11단계: investor-flows 추가)
      if (payload.batch.topic === TOPICS.flows) {
        await handleFlowsBatch(payload);
        return;
      }
      if (payload.batch.topic === TOPICS.indexDaily || payload.batch.topic === TOPICS.disclosures) {
        await handleDailyBatch(payload);
        return;
      }
      if (payload.batch.topic === TOPICS.breadth) {
        await handleBreadthBatch(payload);
        return;
      }
      if (payload.batch.topic === TOPICS.rankings) {
        await handleRankingsBatch(payload);
        return;
      }
      if (payload.batch.topic === TOPICS.marketFlows) {
        await handleMarketFlowsBatch(payload);
        return;
      }
      if (payload.batch.topic === TOPICS.yahooDaily) {
        await handleYahooDailyBatch(payload);
        return;
      }
      const { batch, resolveOffset, heartbeat } = payload;
      const valid: TickData[] = [];

      for (const message of batch.messages) {
        const parsed = parseTick(message.value);
        // change_price 컬럼은 NOT NULL이라, 없으면 묶음 전체가 계속 실패한다. 그래서 DLQ로 보낸다.
        const reason = !parsed.ok ? parsed.reason : parsed.tick.changePrice === undefined ? 'change_price_missing' : undefined;
        if (reason || !parsed.ok) {
          invalidTotal.inc({ reason: reason ?? 'unknown' });
          console.warn(`DB sink skipped invalid message at ${batch.topic}[${batch.partition}]@${message.offset}: ${reason}`);
          await sendToDlq(dlqProducer, { consumer: CONSUMER_NAME, topic: batch.topic, partition: batch.partition, message, reason: reason ?? 'unknown' });
          continue;
        }
        valid.push(parsed.tick);
      }

      if (valid.length > 0) {
        const startedAt = Date.now();
        let inserted: number;
        try {
          const result = await insertBatch(valid);
          inserted = result.inserted;
          scheduleLateRefresh(result.times);
        } catch (error) {
          insertDuration.observe({ result: 'error' }, Date.now() - startedAt);
          // 예외를 던져서 오프셋을 커밋하지 않는다. kafkajs가 같은 묶음을 다시 시도한다 (데이터가 유효하므로 poison이 아님).
          console.error(`DB sink insert failed (${valid.length} rows): ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
        const committedAt = Date.now();
        insertDuration.observe({ result: 'commit' }, committedAt - startedAt);
        batchesTotal.inc();
        rowsInsertedTotal.inc({}, inserted);
        if (inserted < valid.length) {
          duplicatesSkippedTotal.inc({}, valid.length - inserted);
        }
        for (const tick of valid) {
          if (tick.collectedAt !== undefined) {
            storeLatency.observe({}, committedAt - tick.collectedAt);
          }
        }
      }

      const lastMessage = batch.messages[batch.messages.length - 1];
      if (lastMessage) {
        resolveOffset(lastMessage.offset);
      }
      await heartbeat();
    },
  });

  console.log('DB sink consumer started.');

  // 최초 1회 과거 데이터 채우기 (T-19). 실시간 적재와 동시에 진행하고, 실패해도 적재는 계속한다 (다음 기동에서 다시 시도).
  // 이어서 나중에 추가한 지표의 과거 일봉을 채운다 (T-104 ③). 집계를 다시 계산하지 않으므로 위 채우기의 결과와 무관하게 실행한다.
  runBackfillOnce()
    .catch(error => console.error(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`))
    .then(() => runDailyHistoryBackfill(dlqProducer))
    .catch(error => console.error(`Daily history backfill failed: ${error instanceof Error ? error.message : String(error)}`))
    // 공식 종가 보정 (T-136): 장이 정해진 시장의 지표만 지표마다 하루 한 번
    .then(() => runOfficialCloseRefresh(dlqProducer))
    .catch(error => console.error(`Official close refresh failed: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => void recordDbSize());

  setInterval(() => void recordDbSize(), DB_SIZE_INTERVAL_MS);

  // DLQ 다시 처리 (T-129): 검증용 스위치로 켰을 때만 한 번 실행한다. 실패해도 적재는 계속한다
  if (process.env.DLQ_REPLAY === 'true') {
    console.warn('DLQ_REPLAY=true: replaying DLQ messages that pass the current validation (verification only).');
    runDlqReplay(dlqProducer).catch(error => console.error(`[dlq-replay] failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  // 과거 일봉과 실시간 집계 사이의 빈 날을 주기적으로 다시 확인한다 (T-104 ③). 비어 있지 않으면 외부 호출 없음
  // 잠자기 뒤에도 실제 시각에 맞춰 실행한다 (T-140)
  const scheduleDailyHistory = () => setWallClockTimeout(() => {
    runDailyHistoryBackfill(dlqProducer)
      .catch(error => console.error(`Daily history backfill failed: ${error instanceof Error ? error.message : String(error)}`))
      .then(() => runOfficialCloseRefresh(dlqProducer))
      .catch(error => console.error(`Official close refresh failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(scheduleDailyHistory);
  }, DAILY_HISTORY_INTERVAL_MS);
  scheduleDailyHistory();

  // 종료 처리 (docs/Task_ORDER.md T-28): 컨슈머를 먼저 끊는다. kafkajs는 처리 중인 묶음이 끝날 때까지 기다린 뒤 그룹에서 나간다.
  // 커밋하지 못한 묶음은 다음 기동에서 다시 처리되고, 중복은 유니크 제약이 건너뛴다(at-least-once).
  registerShutdown('db-sink', [
    { name: 'kafka consumer', run: () => consumer.disconnect() },
    { name: 'dlq producer', run: () => dlqProducer.disconnect() },
    { name: 'db pool', run: () => dbPool.end() },
  ]);
}

// 시작에 실패하면 종료 코드 1로 끝내서 docker-compose가 다시 띄우게 한다 (T-08과 같은 방식).
run().catch(error => {
  console.error('DB sink failed to start:', error);
  process.exit(1);
});
