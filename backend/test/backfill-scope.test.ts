// 첫 과거 채우기의 집계 재계산 범위 (plan.md QA-08 / P2-2, T-179, BENCHMARK B-76 ⑥)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backfillRefreshScope } from '../src/infrastructure/sink/late-refresh.js';

test('빈 DB(원본보다 오래된 집계 없음)는 넣은 과거 봉을 반영하려고 전체를 다시 계산한다', () => {
  assert.equal(backfillRefreshScope(false), 'full');
});

test('이미 운영한 DB는 전체 재계산을 하지 않는다 (원본이 지워진 과거 버킷이 사라지지 않게)', () => {
  assert.equal(backfillRefreshScope(true), 'policy_only');
});
