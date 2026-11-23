// 정수 설정값 읽기 시험 (plan.md QA-39 / P5-2 축소, docs/Task_ORDER.md T-225, BENCHMARK B-99)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIntSetting } from '../src/infrastructure/int-setting.js';

const read = (value: string | undefined, options = {}) => {
  const warnings: string[] = [];
  const result = readIntSetting('SOME_INTERVAL_MS', 5000, options, { SOME_INTERVAL_MS: value }, message => warnings.push(message));
  return { result, warnings };
};

test('없거나 빈 값은 경고 없이 기본값', () => {
  assert.deepEqual(read(undefined), { result: 5000, warnings: [] });
  assert.deepEqual(read(''), { result: 5000, warnings: [] });
  assert.deepEqual(read('   '), { result: 5000, warnings: [] });
});

test('정수면 그 값(앞뒤 공백 무시)', () => {
  assert.equal(read('1500').result, 1500);
  assert.equal(read(' 60000 ').result, 60000);
  assert.equal(read('1').result, 1);
});

test('정수가 아니면 기본값 + 이름만 남긴 경고 1줄(값은 남기지 않음)', () => {
  for (const value of ['abc', '5000ms', '1.5', '1e3', '0x10', '99999999999999999999']) {
    const { result, warnings } = read(value);
    assert.equal(result, 5000, value);
    assert.equal(warnings.length, 1, value);
    assert.ok(warnings[0]?.includes('SOME_INTERVAL_MS'));
    assert.ok(!warnings[0]?.includes(value), `경고에 값이 들어가면 안 됨: ${value}`);
  }
});

test('0·음수는 기본값(예전 세 가지 동작 중 0 그대로·음수 그대로를 없앰: 주기 0이면 쉬지 않고 돎)', () => {
  assert.equal(read('0').result, 5000);
  assert.equal(read('-1').result, 5000);
  assert.equal(read('-60000').result, 5000);
  assert.equal(read('0').warnings.length, 1);
});

test('0에 뜻이 있는 설정은 { min: 0 }으로 0을 허용(로그 주기 0 = 끔, 과거 채우기 0일)', () => {
  assert.deepEqual(read('0', { min: 0 }), { result: 0, warnings: [] });
  assert.equal(read('-1', { min: 0 }).result, 5000);
  assert.equal(read('10', { min: 0 }).result, 10);
});
