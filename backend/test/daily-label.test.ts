// 일별 값 날짜 검사 시험 (plan.md QA-45, docs/Task_ORDER.md T-223, BENCHMARK B-95)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInvalidDailyLabel } from '../src/infrastructure/sink/data-quality.js';

const KST = (iso: string) => Date.parse(`${iso}+09:00`);

test('오늘 15:30 KST 값을 15:06 KST에 보면 정상 (예전 시각 비교 규칙에서는 fail)', () => {
  const label = KST('2026-11-20T15:30:00');
  const now = KST('2026-11-20T15:06:00');
  assert.equal(label > now, true, '예전 규칙(time > now())이면 fail');
  assert.equal(isInvalidDailyLabel(label, now), false);
});

test('서울 날짜가 오늘보다 뒤면 fail, 주말이면 fail, 지난 평일은 정상', () => {
  const now = KST('2026-11-20T15:06:00'); // 금요일
  assert.equal(isInvalidDailyLabel(KST('2026-11-23T15:30:00'), now), true, '다음 평일(월)');
  assert.equal(isInvalidDailyLabel(KST('2026-11-21T15:30:00'), now), true, '토요일');
  assert.equal(isInvalidDailyLabel(KST('2026-11-15T15:30:00'), now), true, '지난 일요일');
  assert.equal(isInvalidDailyLabel(KST('2026-11-19T15:30:00'), now), false, '어제(목)');
  assert.equal(isInvalidDailyLabel(KST('2026-11-20T23:59:00'), now), false, '오늘 23:59 KST');
});

test('서울 자정 경계: UTC로는 전날이어도 서울 날짜로 판단', () => {
  // 2026-11-23(월) 00:30 KST = 2026-11-22(일) 15:30 UTC → 서울 기준 월요일이라 주말 아님
  const now = KST('2026-11-23T08:00:00');
  assert.equal(isInvalidDailyLabel(KST('2026-11-23T00:30:00'), now), false);
});
