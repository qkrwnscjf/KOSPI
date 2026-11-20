// 반복 오류 메시지 격리 시험 (plan.md QA-05 / P1-6 나머지, docs/Task_ORDER.md T-210, BENCHMARK B-83)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { EachBatchPayload } from 'kafkajs';
import { isDataError, isRepeatableError, REPEAT_LIMIT, resetRepeatFailures, runIsolated } from '../src/infrastructure/sink/batch-isolation.js';

const dbError = (code: string) => Object.assign(new Error('rejected'), { code });

function payload(offsets: string[]) {
  const resolved: string[] = [];
  const events: string[] = [];
  return {
    resolved,
    events,
    value: {
      batch: { topic: 'market-ticks', partition: 0, messages: offsets.map(offset => ({ offset, value: Buffer.from(offset) })) },
      resolveOffset: (offset: string) => { resolved.push(offset); events.push(`resolve:${offset}`); },
      heartbeat: async () => undefined,
    } as unknown as EachBatchPayload,
  };
}

// badOffsets의 메시지가 들어 있으면 code로 실패하는 저장 함수
function handlerFailingOn(badOffsets: string[], code: string, stored: string[]) {
  return async ({ batch, resolveOffset }: EachBatchPayload) => {
    if (batch.messages.some(message => badOffsets.includes(message.offset))) throw dbError(code);
    stored.push(...batch.messages.map(message => message.offset));
    resolveOffset(batch.messages[batch.messages.length - 1]!.offset);
  };
}

beforeEach(() => resetRepeatFailures());

test('T-210 ①: 한도 초과(54000) 메시지는 값 오류처럼 바로 그 메시지만 DLQ', async () => {
  const { value, resolved } = payload(['1', '2', '3']);
  const stored: string[] = [];
  const rejected: string[] = [];
  await runIsolated(value, handlerFailingOn(['2'], '54000', stored), async message => { rejected.push(message.offset); });
  assert.deepEqual(stored, ['1', '3']);
  assert.deepEqual(rejected, ['2']);
  assert.deepEqual(resolved, ['1', '2', '3']);
});

test('T-210 ②: 모든 메시지가 같은 결정적 오류(42703)면 몇 번이든 DLQ 0, 계속 예외', async () => {
  const stored: string[] = [];
  const rejected: string[] = [];
  for (let attempt = 1; attempt <= REPEAT_LIMIT * 3; attempt += 1) {
    const { value, resolved } = payload(['1', '2', '3']);
    await assert.rejects(runIsolated(value, handlerFailingOn(['1', '2', '3'], '42703', stored), async message => { rejected.push(message.offset); }));
    assert.deepEqual(resolved, []);
  }
  assert.deepEqual(stored, []);
  assert.deepEqual(rejected, []);
});

test('T-210 ③: 메시지 하나만 결정적 오류(42883)면 1 · 2번째는 예외, 3번째에 그 메시지만 DLQ하고 DLQ 뒤 오프셋 확정', async () => {
  const stored: string[] = [];
  const rejected: string[] = [];
  for (let attempt = 1; attempt < REPEAT_LIMIT; attempt += 1) {
    const { value, resolved } = payload(['1', '2', '3']);
    await assert.rejects(runIsolated(value, handlerFailingOn(['2'], '42883', stored), async message => { rejected.push(message.offset); }));
    assert.deepEqual(resolved, []);
  }
  assert.deepEqual(rejected, []);
  const { value, resolved, events } = payload(['1', '2', '3']);
  await runIsolated(value, handlerFailingOn(['2'], '42883', stored), async message => { rejected.push(message.offset); events.push(`dlq:${message.offset}`); });
  assert.deepEqual(stored, ['1', '3']);
  assert.deepEqual(rejected, ['2']);
  assert.deepEqual(resolved, ['3']);
  assert.deepEqual(events, ['dlq:2', 'resolve:3']);
});

test('T-210 ④: 일시적 오류(코드 없음 · 08006 · 57P01 · 40001 · 53300 · ECONNRESET)는 10번 실패해도 DLQ 0', async () => {
  for (const make of [() => new Error('timeout'), ...['08006', '57P01', '40001', '53300', 'ECONNRESET'].map(code => () => dbError(code))]) {
    const rejected: string[] = [];
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const { value, resolved } = payload(['1', '2']);
      await assert.rejects(runIsolated(value, async () => { throw make(); }, async message => { rejected.push(message.offset); }));
      assert.deepEqual(resolved, []);
    }
    assert.deepEqual(rejected, []);
  }
});

test('T-210: 오류 분류', () => {
  assert.equal(isDataError(dbError('54000')), true);
  assert.equal(isDataError(dbError('22P02')), true);
  assert.equal(isDataError(dbError('42703')), false);
  assert.equal(isRepeatableError(dbError('42703')), true);
  assert.equal(isRepeatableError(dbError('0A000')), true);
  assert.equal(isRepeatableError(dbError('57P01')), false);
  assert.equal(isRepeatableError(dbError('ECONNRESET')), false);
  assert.equal(isRepeatableError(dbError('EPIPE')), false);
  assert.equal(isRepeatableError(new Error('no code')), false);
});

test('T-210: 성공하면 그 묶음의 실패 횟수를 지운다', async () => {
  const stored: string[] = [];
  const rejected: string[] = [];
  const { value } = payload(['1', '2']);
  await assert.rejects(runIsolated(value, handlerFailingOn(['2'], '42883', stored), async message => { rejected.push(message.offset); }));
  await runIsolated(payload(['1', '2']).value, handlerFailingOn([], '42883', stored), async () => undefined);
  // 다시 1번째 실패부터 센다: 바로 DLQ하지 않음
  await assert.rejects(runIsolated(payload(['1', '2']).value, handlerFailingOn(['2'], '42883', stored), async message => { rejected.push(message.offset); }));
  assert.deepEqual(rejected, []);
});
