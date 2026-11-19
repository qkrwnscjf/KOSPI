// 오류 경계 문구 (plan.md FQA-07, T-200, BENCHMARK B-80 ①)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fallbackText } from '../src/lib/errorBoundary.ts'

test('탭 오류는 다른 탭을 쓸 수 있다고 알리고, 카드 오류는 그 카드만 알린다 (오류 원문은 보여 주지 않음)', () => {
  assert.equal(fallbackText('tab', '국내 전광판'), '국내 전광판 화면을 그리는 중 오류가 났습니다. 다른 탭은 그대로 쓸 수 있습니다.')
  assert.equal(fallbackText('card', '코스피 지수'), '코스피 지수 카드를 그리지 못했습니다.')
})
