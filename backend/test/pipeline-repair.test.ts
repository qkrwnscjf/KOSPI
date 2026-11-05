// 파이프라인 보정 테스트: 늦은 데이터 5분 봉 보정(T-128), DLQ 다시 처리 판단(T-129)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampWindow, mergeWindows, planLateRefresh, POLICY_START_OFFSET_MS, SAFE_RAW_WINDOW_MS } from '../src/infrastructure/sink/late-refresh.js';
import { replayDecision } from '../src/infrastructure/sink/dlq-replay.js';
import { TOPICS } from '../src/infrastructure/kafka.js';

const MIN = 60_000;
const now = Date.parse('2026-10-27T03:02:00Z');

test('planLateRefresh: 정책 범위(최근 2시간) 안이면 보정하지 않는다', () => {
  assert.deepEqual(planLateRefresh(now - 30 * MIN, now), { window: null, unrecoverable: false });
});

test('planLateRefresh: 2시간 ~ 2시간 50분 전 원본은 그 구간만 다시 계산한다 (5분 경계)', () => {
  const { window, unrecoverable } = planLateRefresh(now - 140 * MIN, now); // 2시간 20분 전
  assert.equal(unrecoverable, false);
  assert.equal(window?.start, Date.parse('2026-10-27T00:40:00Z')); // 00:42 → 5분 경계로 내림
  assert.equal(window?.end, Date.parse('2026-10-27T01:05:00Z'));   // 정책 시작(01:02)의 다음 버킷
});

test('planLateRefresh: 2시간 50분보다 오래된 원본은 원본이 지워졌을 수 있어 안전 범위까지만 다시 계산한다', () => {
  const { window, unrecoverable } = planLateRefresh(now - 5 * 60 * MIN, now);
  assert.equal(unrecoverable, true);
  assert.ok(window && window.start >= now - SAFE_RAW_WINDOW_MS);
  assert.ok(window && window.end <= now - POLICY_START_OFFSET_MS + 5 * MIN);
});

test('clampWindow · mergeWindows: 기다리는 사이 안전 범위를 벗어난 앞부분은 잘라 낸다', () => {
  const merged = mergeWindows({ start: 100, end: 200 }, { start: 50, end: 150 });
  assert.deepEqual(merged, { start: 50, end: 200 });
  const window = { start: now - 170 * MIN, end: now - 115 * MIN };
  const later = now + 30 * MIN; // 30분 뒤 실행
  const clamped = clampWindow(window, later);
  assert.ok(clamped === null || clamped.start >= later - SAFE_RAW_WINDOW_MS);
});

test('replayDecision: 지금 규칙으로 통과하는 메시지만 원래 토픽으로 되돌리고, 여전히 잘못된 것은 그대로 둔다', () => {
  const tick = { symbol: 'KOSPI', category: 'domestic', price: 2600, changeRate: 0.1, changePrice: 2.6, timestamp: 1_790_000_000_000 };
  assert.deepEqual(replayDecision(TOPICS.ticks, Buffer.from(JSON.stringify(tick))), { replay: true });
  assert.deepEqual(replayDecision(TOPICS.ticks, Buffer.from('not-json')), { replay: false, reason: 'invalid_json' });
  // db-sink 기준: 등락폭이 없는 tick은 저장할 수 없어 되돌리지 않는다
  const { changePrice: _omit, ...noChange } = tick;
  assert.equal(replayDecision(TOPICS.ticks, Buffer.from(JSON.stringify(noChange))).replay, false);
  assert.deepEqual(replayDecision('unknown-topic', Buffer.from(JSON.stringify(tick))), { replay: false, reason: 'unknown_source_topic' });
});
