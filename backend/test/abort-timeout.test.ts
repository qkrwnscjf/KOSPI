// 시간 제한 + 실제 요청 중단 테스트 (docs/Task_ORDER.md T-150)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeoutError, withAbortTimeout } from '../src/infrastructure/abort-timeout.js';

test('withAbortTimeout: 제한 안에 끝나면 결과를 돌려주고 신호는 중단되지 않는다', async () => {
  let aborted = false;
  const value = await withAbortTimeout(async signal => {
    signal.addEventListener('abort', () => { aborted = true; });
    return 7;
  }, 50);
  assert.equal(value, 7);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(aborted, false);
});

test('withAbortTimeout: 제한을 넘기면 요청을 중단하고 TimeoutError', async () => {
  let aborted = false;
  const startedAt = Date.now();
  await assert.rejects(withAbortTimeout(signal => new Promise<never>(() => {
    signal.addEventListener('abort', () => { aborted = true; });
  }), 20), TimeoutError);
  assert.equal(aborted, true);
  assert.ok(Date.now() - startedAt < 500);
});

test('withAbortTimeout: 요청 자체의 오류는 그대로 전달한다', async () => {
  await assert.rejects(withAbortTimeout(async () => { throw new Error('http 500'); }, 50), /http 500/);
});
