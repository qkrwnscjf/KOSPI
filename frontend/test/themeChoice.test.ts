// 처음 화면의 테마 (plan.md FQA-12, T-203, BENCHMARK B-80 ④)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialTheme } from '../src/lib/themeChoice.ts'

test('저장된 선택이 있으면 운영체제 설정보다 먼저 쓴다', () => {
  assert.equal(initialTheme('light', true), 'light')
  assert.equal(initialTheme('dark', false), 'dark')
})

test('저장된 선택이 없거나 이상한 값이면 운영체제 설정을 따른다 (예전에는 항상 라이트)', () => {
  assert.equal(initialTheme(null, true), 'dark')
  assert.equal(initialTheme(null, false), 'light')
  assert.equal(initialTheme('purple', true), 'dark')
})
