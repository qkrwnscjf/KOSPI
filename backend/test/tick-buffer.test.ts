// worker tick 버퍼 시험 (plan.md P2-6 · QA-13, docs/Task_ORDER.md T-218, BENCHMARK B-90)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTickBuffer, TICK_BUFFER_LIMITS } from '../src/infrastructure/ingestion/tick-buffer.js';

const tick = (id: number, collectedAt: number) => ({ id, collectedAt });

test('보내지 못한 묶음을 되돌리면 다음에 수집 순서 그대로 먼저 나온다', () => {
  const buffer = createTickBuffer<{ id: number; collectedAt: number }>();
  assert.equal(buffer.restore([tick(1, 1_000), tick(2, 2_000)], 3_000), 0);
  // 다음 주기: 버퍼를 꺼내 새 tick과 합쳐 보내다 또 실패 → 합친 묶음을 그대로 되돌림
  const second = [...buffer.drain(), tick(3, 4_000)];
  assert.equal(buffer.size(), 0);
  buffer.restore(second, 5_000);
  assert.deepEqual(buffer.drain().map(item => item.id), [1, 2, 3]);
});

test('상한: 10분보다 오래된 것과 5,000개를 넘는 오래된 것부터 버리고 수를 돌려준다', () => {
  assert.deepEqual(TICK_BUFFER_LIMITS, { maxAgeMs: 600_000, maxCount: 5_000 });
  const byAge = createTickBuffer<{ id: number; collectedAt: number }>();
  const now = 1_000_000;
  assert.equal(byAge.restore([tick(1, now - 600_001), tick(2, now - 600_000), tick(3, now)], now), 1);
  assert.deepEqual(byAge.drain().map(item => item.id), [2, 3]);

  const byCount = createTickBuffer<{ id: number; collectedAt: number }>({ maxAgeMs: 600_000, maxCount: 3 });
  assert.equal(byCount.restore([1, 2, 3, 4, 5].map(id => tick(id, now)), now), 2);
  assert.deepEqual(byCount.drain().map(item => item.id), [3, 4, 5]);
});
