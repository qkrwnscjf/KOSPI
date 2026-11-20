// 그래프 채우기 0건 처리 시험 (plan.md P2-5 · QA-16, docs/Task_ORDER.md T-217, BENCHMARK B-89)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyFillRetryAllowed, FILL_EMPTY_RETRY_LIMIT, findGap, needsFill, shouldRecordFill } from '../src/infrastructure/sink/intraday-fill.js';

test('① 응답 전체가 0건이면 "요청해 봤음"을 기록하지 않고, 봉이 있으면 기록한다', () => {
  assert.equal(shouldRecordFill(0), false);
  assert.equal(shouldRecordFill(1), true);
  assert.equal(shouldRecordFill(288), true);
});

test('② 0건 재시도는 지표·해상도마다 3번까지', () => {
  assert.equal(FILL_EMPTY_RETRY_LIMIT, 3);
  assert.equal(emptyFillRetryAllowed(undefined), true);
  assert.equal(emptyFillRetryAllowed(2), true);
  assert.equal(emptyFillRetryAllowed(3), false);
});

test('③ 기록이 없으면 품질 검사 공백 판단이 그 칸을 세고, 기록이 있으면 그 칸 이전은 세지 않는다', () => {
  // 2026-11-17(화) 국내 장중: 01:00 ~ 02:30 UTC(10:00 ~ 11:30 KST) 5분 칸 18개가 빔
  const nowMs = Date.parse('2026-11-17T06:00:00Z');
  const step = 5 * 60_000;
  const existing: number[] = [];
  // 24시간 범위의 다른 칸은 모두 값이 있음(전날 장 마감 직전 칸 포함)
  for (let slot = Date.parse('2026-11-16T06:00:00Z'); slot < Date.parse('2026-11-17T06:00:00Z'); slot += step) {
    if (slot < Date.parse('2026-11-17T01:00:00Z') || slot >= Date.parse('2026-11-17T02:30:00Z')) existing.push(slot);
  }
  const notRecorded = findGap(existing, 'krx', '5m', nowMs, null);
  assert.ok(needsFill(notRecorded, '5m'), '0건이라 기록하지 않음 → 공백이 보임');
  const recorded = findGap(existing, 'krx', '5m', nowMs, Date.parse('2026-11-17T03:00:00Z'));
  assert.equal(needsFill(recorded, '5m'), false, '예전: 0건이어도 기록 → 공백이 사라짐');
});
