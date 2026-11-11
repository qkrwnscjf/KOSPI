// 실적·배당 캘린더의 주말·공휴일 구분 테스트 (docs/Task_ORDER.md T-167)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KR_HOLIDAYS, dayKind, holidayName } from '../src/lib/calendar.ts'

test('dayKind: 평일·토요일·일요일을 구분한다', () => {
  assert.equal(dayKind('2026-11-11'), 'weekday') // 수
  assert.equal(dayKind('2026-11-14'), 'saturday')
  assert.equal(dayKind('2026-11-15'), 'sunday')
})

test('dayKind: 공휴일은 요일보다 먼저이고, 토요일과 겹친 공휴일도 공휴일이다', () => {
  assert.equal(dayKind('2026-02-17'), 'holiday') // 설날(화)
  assert.equal(dayKind('2026-10-03'), 'holiday') // 개천절(토)
  assert.equal(dayKind('2026-10-05'), 'holiday') // 대체공휴일(월)
  assert.equal(holidayName('2026-10-05'), '대체공휴일')
  assert.equal(holidayName('2026-11-11'), null)
})

test('KR_HOLIDAYS: 날짜 형식이 올바르고 이름이 비어 있지 않다', () => {
  for (const [date, name] of Object.entries(KR_HOLIDAYS)) {
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, date)
    assert.ok(!Number.isNaN(new Date(`${date}T00:00:00Z`).getTime()), date)
    assert.ok(name.length > 0, date)
  }
})
