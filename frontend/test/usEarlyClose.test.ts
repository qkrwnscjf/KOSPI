// 미국 조기 폐장 시험 (plan.md P2-7 · QA-17, docs/Task_ORDER.md T-219, BENCHMARK B-91)
// backend/test/us-early-close.test.ts와 같은 사례다. 표의 날짜는 시험용(실제 표는 거래소 공지 확인 전이라 비어 있음)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMarketOpen, US_EARLY_CLOSES } from '../src/lib/marketHours.ts'

const TEST_TABLE = { '2026-11-27': { close: 13 * 60 } } // 시험용: 금요일 13:00 ET(EST, UTC-5) = 18:00 UTC

test('① 표에 있는 날은 13:00 ET부터 미국 장 배지가 닫힌다 (12:59는 열림)', () => {
  assert.equal(isMarketOpen('us_equity', new Date('2026-11-27T17:59:00Z'), TEST_TABLE), true)
  assert.equal(isMarketOpen('us_equity', new Date('2026-11-27T18:00:00Z'), TEST_TABLE), false)
  assert.equal(isMarketOpen('us_equity', new Date('2026-11-27T18:00:00Z'), {}), true)
  assert.equal(isMarketOpen('us_equity', new Date('2026-11-30T18:00:00Z'), TEST_TABLE), true)
  assert.equal(isMarketOpen('global_24h', new Date('2026-11-27T18:00:00Z'), TEST_TABLE), true, '다른 시장은 그대로')
})

test('④ 실제 표는 비어 있어(날짜 확인 전) 지금 동작은 그대로', () => {
  assert.deepEqual(US_EARLY_CLOSES, {})
  assert.equal(isMarketOpen('us_equity', new Date('2026-11-27T18:00:00Z')), true)
})
