// 카드 데이터 상태 한 줄 테스트 (docs/Task_ORDER.md T-168, BENCHMARK B-70)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STALE_AFTER_MS, dataStatus, formatAge } from '../src/lib/dataStatus.ts'

const now = Date.parse('2026-11-11T04:00:00Z')

test('장중 + 소스 지연 + 수집 시각: 지연과 수신 시각을 따로 보여 준다', () => {
  const status = dataStatus({ marketLabel: '장중', marketOpen: true, delayMinutes: 20, sourceTime: now - 20 * 60_000, receivedAt: now - 12_000, now })
  assert.deepEqual(status, { parts: ['장중', '20분 지연', '12초 전 수신'], stale: false })
})

test('지연 없는 지표는 지연 표시가 없다', () => {
  const status = dataStatus({ marketLabel: '장중', marketOpen: true, delayMinutes: null, sourceTime: now - 3000, receivedAt: now - 1000, now })
  assert.deepEqual(status.parts, ['장중', '1초 전 수신'])
})

test('수집 시각이 없으면 예전처럼 소스 시각 기준으로 보여 준다', () => {
  const status = dataStatus({ marketLabel: '장 마감', marketOpen: false, delayMinutes: null, sourceTime: now - 2 * 3600_000, receivedAt: null, now })
  assert.deepEqual(status, { parts: ['장 마감', '기준 2시간 전'], stale: false })
})

test('장중에 15분 넘게 새 값이 없으면 갱신 지연, 경계 직전은 아니다', () => {
  const at = (age: number) => dataStatus({ marketLabel: '장중', marketOpen: true, delayMinutes: null, sourceTime: now - age, receivedAt: now - age, now })
  assert.equal(at(STALE_AFTER_MS).stale, false)
  const stale = at(STALE_AFTER_MS + 1000)
  assert.equal(stale.stale, true)
  assert.equal(stale.parts.at(-1), '갱신 지연')
})

test('장이 닫혀 있거나 휴장이면 오래된 값이어도 갱신 지연이 아니다', () => {
  assert.equal(dataStatus({ marketLabel: '장 마감', marketOpen: false, delayMinutes: null, sourceTime: now - 86_400_000, receivedAt: now - 86_400_000, now }).stale, false)
  assert.equal(dataStatus({ marketLabel: '휴장', marketOpen: false, delayMinutes: null, sourceTime: now - 86_400_000, receivedAt: now - 86_400_000, now }).stale, false)
})

test('수집 시각이 없을 때는 소스 지연만큼 빼고 판단한다(20분 늦은 지표가 늘 갱신 지연으로 보이지 않게)', () => {
  const status = dataStatus({ marketLabel: '장중', marketOpen: true, delayMinutes: 20, sourceTime: now - 25 * 60_000, receivedAt: null, now })
  assert.equal(status.stale, false)
})

test('값이 아직 없으면 장 상태만 보여 준다', () => {
  assert.deepEqual(dataStatus({ marketLabel: '장중', marketOpen: true, delayMinutes: 20, sourceTime: null, receivedAt: null, now }), { parts: ['장중', '20분 지연'], stale: false })
})

test('formatAge: 초·분·시간·일', () => {
  assert.equal(formatAge(59_000), '59초 전')
  assert.equal(formatAge(60_000), '1분 전')
  assert.equal(formatAge(3600_000), '1시간 전')
  assert.equal(formatAge(86_400_000), '1일 전')
  assert.equal(formatAge(-5), '0초 전')
})
