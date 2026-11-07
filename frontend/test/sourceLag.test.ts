// 소스 지연 표시 테스트 (docs/Task_ORDER.md T-162)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { combineLags, delayBadgeMinutes, toSourceLags } from '../src/lib/sourceLag.ts'

const lag = (lagSeconds: number, measuredAt = 1_794_000_000_000) => ({ lagSeconds, samples: 30, measuredAt })

test('delayBadgeMinutes: 1분 미만이나 측정값 없음은 배지 없음, 나머지는 분으로 반올림', () => {
  assert.equal(delayBadgeMinutes(undefined), null)
  assert.equal(delayBadgeMinutes(lag(7)), null)       // 원/달러 수준
  assert.equal(delayBadgeMinutes(lag(59)), null)
  assert.equal(delayBadgeMinutes(lag(60)), 1)
  assert.equal(delayBadgeMinutes(lag(1201)), 20)      // 국내 약 20분
  assert.equal(delayBadgeMinutes(lag(905)), 15)       // 니케이 약 15분
})

test('combineLags: 계산 카드는 더 늦은 지표를 따르고, 한쪽이 없으면 없음', () => {
  assert.deepEqual(combineLags(lag(900, 2), lag(30, 1)), { lagSeconds: 900, samples: 30, measuredAt: 1 })
  assert.equal(combineLags(lag(900), undefined), undefined)
})

test('toSourceLags: 형식이 맞는 지표만 남긴다', () => {
  const body = { data: { KOSPI: lag(1201), BAD: { lagSeconds: '1201', samples: 1, measuredAt: 1 }, NEG: lag(-5) } }
  assert.deepEqual(Object.keys(toSourceLags(body)), ['KOSPI'])
  assert.deepEqual(toSourceLags(null), {})
  assert.deepEqual(toSourceLags({ data: 'x' }), {})
})
