// 화면 공통 상수·상태 문구 시험 (plan.md FQA-08 · 16, docs/Task_ORDER.md T-221 · T-222, BENCHMARK B-93 · B-94)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CARD_FRAME, isLoadingText, STATUS_TEXT, statusText } from '../src/lib/ui.ts'

test('상태 문구: 준비 중·오류는 데이터와 상관없이, 불러오는 중·빈 데이터는 데이터가 없을 때만', () => {
  assert.equal(statusText('not_ready', false), STATUS_TEXT.notReady)
  assert.equal(statusText('error', false), STATUS_TEXT.error)
  assert.equal(statusText('loading', true), STATUS_TEXT.loading)
  assert.equal(statusText('loading', false), null, '이전 값이 있으면 그대로 보여 줌')
  assert.equal(statusText('loaded', true), STATUS_TEXT.empty)
  assert.equal(statusText('loaded', true, '이 날의 공시가 없습니다'), '이 날의 공시가 없습니다')
  assert.equal(statusText('loaded', false), null)
})

test('골격은 "불러오는 중"일 때만', () => {
  assert.equal(isLoadingText(STATUS_TEXT.loading), true)
  assert.equal(isLoadingText(STATUS_TEXT.error), false)
  assert.equal(isLoadingText(null), false)
})

test('카드 틀 한 곳: 테두리·배경·둥근 모서리·호버 빛', () => {
  for (const token of ['card-neon', 'rounded-xl', 'border', 'border-line', 'bg-surface']) {
    assert.ok(CARD_FRAME.split(' ').includes(token), token)
  }
})
