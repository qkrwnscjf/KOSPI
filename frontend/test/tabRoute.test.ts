// 탭과 URL 해시 (plan.md FQA-06, T-202, BENCHMARK B-80 ③)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashFor, tabFromHash } from '../src/lib/tabRoute.ts'

const TABS = [{ id: 'category1', slug: 'domestic' }, { id: 'category4', slug: 'sectors' }, { id: 'category7', slug: 'risk' }]

test('해시로 탭을 열고(새로고침·뒤로가기·링크 공유), 탭으로 해시를 만든다', () => {
  assert.equal(tabFromHash('#/sectors', TABS, 'category1'), 'category4')
  assert.equal(tabFromHash('#risk', TABS, 'category1'), 'category7')
  assert.equal(tabFromHash('#/risk?from=link', TABS, 'category1'), 'category7')
  assert.equal(hashFor('sectors'), '#/sectors')
  assert.equal(tabFromHash(hashFor('domestic'), TABS, 'category4'), 'category1')
})

test('해시가 없거나 모르는 값이면 첫 탭으로 연다', () => {
  assert.equal(tabFromHash('', TABS, 'category1'), 'category1')
  assert.equal(tabFromHash('#/unknown', TABS, 'category1'), 'category1')
  assert.equal(tabFromHash('#/<script>', TABS, 'category1'), 'category1')
})
