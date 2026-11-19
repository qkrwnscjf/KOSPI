// 보관 초과 경고는 보관 작업 한 번을 기다린 뒤에 (plan.md QA-24 / P3-3, T-184)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalRetentionWithGrace } from '../src/infrastructure/sink/data-quality.js';

const T0 = Date.parse('2026-11-19T07:00:00Z');
const MIN = 60_000;

test('기동 직후 늦게 저장된 원본(T-174)은 다음 보관 실행이 지우면 경고 없이 끝난다', () => {
  const firstSeen = new Map<string, number>();
  const lastRun = new Map([['market_ticks', T0 - 10 * MIN]]); // 직전 보관 실행은 늦은 원본보다 먼저
  // 15분마다 검사: 보관 작업이 아직 다시 돌지 않았으면 기다림
  assert.deepEqual(evalRetentionWithGrace(['market_ticks'], lastRun, firstSeen, T0), { warn: [], waiting: ['market_ticks'] });
  assert.deepEqual(evalRetentionWithGrace(['market_ticks'], lastRun, firstSeen, T0 + 15 * MIN), { warn: [], waiting: ['market_ticks'] });
  // 다음 보관 실행이 지움 → 한계를 넘은 표가 없어지고 기억도 지운다
  assert.deepEqual(evalRetentionWithGrace([], new Map([['market_ticks', T0 + 50 * MIN]]), firstSeen, T0 + 60 * MIN), { warn: [], waiting: [] });
  assert.equal(firstSeen.size, 0);
});

test('보관 작업이 다시 돌았는데도 남아 있으면 경고한다 (실제로 지우지 못하는 경우)', () => {
  const firstSeen = new Map<string, number>();
  evalRetentionWithGrace(['market_ticks'], new Map([['market_ticks', T0 - 10 * MIN]]), firstSeen, T0);
  const result = evalRetentionWithGrace(['market_ticks'], new Map([['market_ticks', T0 + 50 * MIN]]), firstSeen, T0 + 60 * MIN);
  assert.deepEqual(result, { warn: ['market_ticks'], waiting: [] });
});

test('보관 작업 기록이 없는 표는 기다리지 않고 바로 경고한다', () => {
  assert.deepEqual(evalRetentionWithGrace(['dq_results'], new Map(), new Map(), T0), { warn: ['dq_results'], waiting: [] });
});
