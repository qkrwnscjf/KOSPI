// worker 변경 감지·백오프·버퍼 경계 시험 (plan.md QA-42 / P6-2 축소, docs/Task_ORDER.md T-226, BENCHMARK B-100)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, isFreshTick } from '../src/infrastructure/ingestion/poll-policy.js';
import { createTickBuffer } from '../src/infrastructure/ingestion/tick-buffer.js';

const T = Date.UTC(2026, 10, 23, 1, 0); // 2026-11-23 10:00 KST

test('변경 감지: 처음 본 지표와 더 새로운 소스 시각만 보낸다', () => {
  const sent = { timestamp: T, marketState: 'REGULAR' as const };
  assert.equal(isFreshTick({ timestamp: T, marketState: 'REGULAR' }, { timestamp: undefined, marketState: undefined }), true, '처음 본 지표');
  assert.equal(isFreshTick({ timestamp: T + 1, marketState: 'REGULAR' }, sent), true, '1ms라도 새 시각');
  assert.equal(isFreshTick({ timestamp: T, marketState: 'REGULAR' }, sent), false, '같은 시각');
  assert.equal(isFreshTick({ timestamp: T - 60_000, marketState: 'REGULAR' }, sent), false, '옛 시각(늦게 온 응답)');
});

test('변경 감지: 시각이 같아도 장 상태가 바뀌면 보내고, 장 상태가 없는 tick은 바뀜으로 보지 않는다', () => {
  const sent = { timestamp: T, marketState: 'REGULAR' as const };
  assert.equal(isFreshTick({ timestamp: T, marketState: 'POST' }, sent), true, 'REGULAR → POST');
  assert.equal(isFreshTick({ timestamp: T, marketState: 'CLOSED' }, sent), true, 'REGULAR → CLOSED(휴장 표시)');
  assert.equal(isFreshTick({ timestamp: T, marketState: undefined }, sent), false, '장 상태 없음');
  assert.equal(isFreshTick({ timestamp: T, marketState: 'POST' }, { timestamp: T, marketState: undefined }), true, '보낸 장 상태를 모름(시드에 없음)');
  assert.equal(isFreshTick({ timestamp: T - 1, marketState: 'POST' }, sent), true, '옛 시각이어도 장 상태가 바뀌면 보냄(예전 동작 그대로)');
});

test('변경 감지: 검증 모드(WORKER_TEST_SEND_UNCHANGED)는 같은 시각도 보낸다', () => {
  assert.equal(isFreshTick({ timestamp: T, marketState: 'REGULAR' }, { timestamp: T, marketState: 'REGULAR' }, true), true);
});

test('백오프: 실패 0회 = 주기, n회 = 2ⁿ배, 상한 = max(최대 백오프, 주기)', () => {
  assert.equal(backoffDelay(5_000, 0, 60_000), 5_000);
  assert.equal(backoffDelay(5_000, 1, 60_000), 10_000);
  assert.equal(backoffDelay(5_000, 3, 60_000), 40_000);
  assert.equal(backoffDelay(5_000, 4, 60_000), 60_000, '80초 → 상한 60초');
  assert.equal(backoffDelay(5_000, 1_000, 60_000), 60_000, '실패 수가 매우 커도(2^1000 = Infinity) 상한');
  assert.equal(backoffDelay(5_000, -1, 60_000), 5_000, '음수는 실패 없음으로');
});

test('백오프: 유휴 주기가 최대 백오프보다 길어도 백오프 때문에 짧아지지 않는다', () => {
  assert.equal(backoffDelay(120_000, 1, 60_000), 120_000, '유휴 120초 + 실패 1회 → 120초(60초로 줄지 않음)');
  assert.equal(backoffDelay(60_000, 5, 60_000), 60_000, '유휴 60초 = 상한 60초');
  assert.equal(backoffDelay(15_000, 2, 60_000), 60_000, '휴장 주기 15초 × 4 = 60초');
});

test('버퍼 경계: 정확히 상한 개수면 버리지 않고, 수집 시각이 없는 항목은 나이로 버리지 않으며, 빈 묶음은 0', () => {
  const now = 10_000_000;
  const exact = createTickBuffer<{ id: number; collectedAt?: number }>({ maxAgeMs: 600_000, maxCount: 3 });
  assert.equal(exact.restore([1, 2, 3].map(id => ({ id, collectedAt: now })), now), 0);
  assert.equal(exact.size(), 3);

  const noTime = createTickBuffer<{ id: number; collectedAt?: number }>();
  assert.equal(noTime.restore([{ id: 1 }, { id: 2, collectedAt: now - 600_001 }], now), 1);
  assert.deepEqual(noTime.drain().map(item => item.id), [1]);

  const empty = createTickBuffer<{ id: number; collectedAt?: number }>();
  assert.equal(empty.restore([], now), 0);
  assert.deepEqual(empty.drain(), []);
});

test('버퍼 경계: 나이와 개수 상한이 함께 걸리면 오래된 것부터 버린 수를 모두 센다', () => {
  const now = 10_000_000;
  const buffer = createTickBuffer<{ id: number; collectedAt?: number }>({ maxAgeMs: 600_000, maxCount: 2 });
  const batch = [
    { id: 1, collectedAt: now - 700_000 }, // 나이 초과
    { id: 2, collectedAt: now - 300_000 }, // 개수 초과(가장 오래된 남은 것)
    { id: 3, collectedAt: now - 200_000 },
    { id: 4, collectedAt: now },
  ];
  assert.equal(buffer.restore(batch, now), 2);
  assert.deepEqual(buffer.drain().map(item => item.id), [3, 4]);
});
