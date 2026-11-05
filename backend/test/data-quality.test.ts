// DB 데이터 품질관리 테스트 (docs/Task_ORDER.md T-154, T-118, T-119, BENCHMARK B-62)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EachBatchPayload } from 'kafkajs';
import { parseTick } from '../src/shared/tick-validation.js';
import { isPlausibleEventTime } from '../src/shared/event-time.js';
import { parseIngestionRun, safeKind } from '../src/shared/ingestion-runs.js';
import { isDataError, runIsolated } from '../src/infrastructure/sink/batch-isolation.js';
import { evalCloseMissing, evalFreshness, evalMissingDays, evalRetention, RETENTION_LIMITS } from '../src/infrastructure/sink/data-quality.js';
import { detected } from '../src/infrastructure/sink/data-quality-inject.js';
import { YAHOO_KEYS } from '../src/shared/symbols.js';

const NOW = Date.parse('2026-11-05T02:00:00Z'); // 목 11:00 KST: 국내·도쿄·대만·24시간 시장 열림, 미국 닫힘
const tick = (fields: Record<string, unknown>) => Buffer.from(JSON.stringify({ symbol: 'KOSPI', category: 'domestic', price: 1, changeRate: 0, changePrice: 0, timestamp: 1_790_000_000_000, ...fields }));

test('T-154: DB 칼럼이 거부하는 거래량·시각은 검증에서 거른다', () => {
  assert.deepEqual(parseTick(tick({ volume: 1.5 })), { ok: false, reason: 'volume' });
  assert.deepEqual(parseTick(tick({ volume: -1 })), { ok: false, reason: 'volume' });
  assert.equal(parseTick(tick({ volume: 0 })).ok, true);
  assert.deepEqual(parseTick(tick({ timestamp: 1e30 })), { ok: false, reason: 'timestamp' });
  assert.deepEqual(parseTick(tick({ timestamp: 1000 })), { ok: false, reason: 'timestamp' });
});

test('T-154: 시각 범위는 2000년부터 지금 + 36시간까지', () => {
  assert.equal(isPlausibleEventTime(NOW, NOW), true);
  assert.equal(isPlausibleEventTime(NOW + 35 * 3600_000, NOW), true);
  assert.equal(isPlausibleEventTime(NOW + 37 * 3600_000, NOW), false);
  assert.equal(isPlausibleEventTime('1', NOW), false);
});

const dbError = (code: string) => Object.assign(new Error('rejected'), { code });

function payload(offsets: string[]) {
  const resolved: string[] = [];
  return {
    resolved,
    value: {
      batch: { topic: 'market-ticks', partition: 0, messages: offsets.map(offset => ({ offset, value: Buffer.from(offset) })) },
      resolveOffset: (offset: string) => resolved.push(offset),
      heartbeat: async () => undefined,
    } as unknown as EachBatchPayload,
  };
}

test('T-154: 값 오류면 한 건씩 저장하고 거부된 메시지만 DLQ로 보낸다', async () => {
  const { value, resolved } = payload(['1', '2', '3']);
  const stored: string[] = [];
  const rejected: string[] = [];
  await runIsolated(value, async ({ batch, resolveOffset }) => {
    if (batch.messages.some(message => message.offset === '2')) throw dbError('22P02');
    stored.push(...batch.messages.map(message => message.offset));
    resolveOffset(batch.messages[batch.messages.length - 1]!.offset);
  }, async message => { rejected.push(message.offset); });
  assert.deepEqual(stored, ['1', '3']);
  assert.deepEqual(rejected, ['2']);
  assert.deepEqual(resolved, ['1', '2', '3']);
});

test('T-154: 연결 오류는 그대로 던져 오프셋을 확정하지 않는다', async () => {
  const { value, resolved } = payload(['1']);
  await assert.rejects(runIsolated(value, async () => { throw new Error('connection terminated'); }, async () => undefined));
  await assert.rejects(runIsolated(value, async () => { throw dbError('57P01'); }, async () => undefined));
  assert.deepEqual(resolved, []);
  assert.equal(isDataError(dbError('23505')), true);
  assert.equal(isDataError(dbError('21000')), true);
  assert.equal(isDataError(dbError('08006')), false);
});

const RUN = { runId: '123e4567-e89b-42d3-a456-426614174000', source: 'krx_index', endpoint: '/idx/krx_dd_trd', targetFrom: '2026-11-04', targetTo: '2026-11-04', received: 21, sent: 21, dropped: { missing_value: 0 }, status: 'ok', errorKind: null, sourceTotal: null, covered: null, startedAt: 1_790_000_000_000, finishedAt: 1_790_000_000_100 };
const parseRun = (fields: Record<string, unknown>) => parseIngestionRun(Buffer.from(JSON.stringify({ ...RUN, ...fields })));

test('T-118: 실행 기록은 고정 형식만 받아 URL·오류 원문이 들어가지 않는다', () => {
  assert.equal(parseRun({}).ok, true);
  assert.deepEqual(parseRun({ endpoint: 'https://example.com/a?key=1' }), { ok: false, reason: 'endpoint' });
  assert.deepEqual(parseRun({ errorKind: 'request to https://example.com failed' }), { ok: false, reason: 'error_kind' });
  assert.deepEqual(parseRun({ source: 'naver' }), { ok: false, reason: 'source' });
  assert.deepEqual(parseRun({ dropped: { 'bad reason': 1 } }), { ok: false, reason: 'dropped' });
  assert.deepEqual(parseRun({ received: 1.5 }), { ok: false, reason: 'counts' });
  assert.deepEqual(parseRun({ targetFrom: '2026-13-45' }), { ok: false, reason: 'target' });
  assert.equal(safeKind('http_503'), 'http_503');
  assert.equal(safeKind('https://example.com?key=secret'), 'other');
});

test('T-119 freshness: 일부가 멈추면 warn, 열린 지표가 모두 멈추면 fail, 닫힌 시장은 보지 않는다', () => {
  const fresh = new Map(YAHOO_KEYS.map(key => [key as string, NOW - 60_000]));
  assert.equal(evalFreshness(fresh, NOW).status, 'ok');
  const oneStale = new Map(fresh);
  oneStale.set('KOSPI', NOW - 2 * 3600_000);
  const warned = evalFreshness(oneStale, NOW);
  assert.equal(warned.status, 'warn');
  assert.deepEqual(warned.detail, ['KOSPI']);
  assert.equal(evalFreshness(new Map(), NOW).status, 'fail');
  // 미국 장이 닫혀 있으면 오래된 S&P 500은 문제가 아니다
  const usClosed = new Map(fresh);
  usClosed.set('SP500', NOW - 12 * 3600_000);
  assert.equal(evalFreshness(usClosed, NOW).status, 'ok');
});

test('T-119 close_missing: 장이 끝나고 2시간이 지났는데 그 장의 일봉이 없으면 잡는다', () => {
  const after = Date.parse('2026-11-05T09:00:00Z'); // 18:00 KST
  const dayRow = Date.parse('2026-11-05T06:30:00Z');
  const previous = Date.parse('2026-11-04T06:30:00Z');
  const keys = YAHOO_KEYS.filter(key => !['USD/KRW'].includes(key));
  const complete = new Map(keys.map(key => [key as string, dayRow]));
  assert.equal(evalCloseMissing(complete, after).status, 'ok');
  const missing = new Map(complete);
  missing.set('SAMSUNG', previous);
  const result = evalCloseMissing(missing, after);
  assert.equal(result.status, 'warn');
  assert.deepEqual(result.detail, ['SAMSUNG']);
  // 코스피 200은 Yahoo 일봉이 없어 보지 않는다
  const without200 = new Map(complete);
  without200.delete('KOSPI200');
  assert.equal(evalCloseMissing(without200, after).status, 'ok');
});

test('T-119 missing_days: 항목이 시작된 뒤의 빠진 날만 잡는다', () => {
  const expected = ['2026-11-02', '2026-11-03', '2026-11-04'];
  const present = new Map([['A', ['2026-11-02', '2026-11-04']], ['B', ['2026-11-03', '2026-11-04']], ['C', expected]]);
  assert.deepEqual(evalMissingDays(expected, present, ['A', 'B', 'C']), ['A:2026-11-03']);
  assert.deepEqual(evalMissingDays(expected, present, ['D']), ['D:2026-11-02', 'D:2026-11-03', 'D:2026-11-04']);
});

test('T-119 retention: 보관 기간 + 청크 간격을 넘긴 표만 잡는다', () => {
  const limit = RETENTION_LIMITS.index_daily_krx!.limitMs;
  assert.deepEqual(evalRetention([{ name: 'index_daily_krx', age_ms: limit - 1 }, { name: 'market_1d', age_ms: null }]), []);
  assert.deepEqual(evalRetention([{ name: 'index_daily_krx', age_ms: limit + 1 }]), ['index_daily_krx']);
});

test('T-119 주입 검증: 상태가 나빠지거나 관측값이 늘어야 검출로 본다', () => {
  const ok = { dataset: 'db', check: 'jobs', status: 'ok' as const, observed: 0, expected: 0, detail: [] };
  const warn = { ...ok, status: 'warn' as const, observed: 1 };
  assert.equal(detected([ok], [warn], 'db/jobs'), true);
  assert.equal(detected([warn], [{ ...warn, observed: 2 }], 'db/jobs'), true);
  assert.equal(detected([warn], [warn], 'db/jobs'), false);
  assert.equal(detected([ok], [ok], 'db/jobs'), false);
});
