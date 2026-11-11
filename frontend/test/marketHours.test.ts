// 장 시간 판단 테스트 (docs/Task_ORDER.md T-45, T-42, D-36)
// backend/test/market-hours.test.ts와 같은 사례다. 화면용 복사본(lib/marketHours.ts)이 백엔드 규칙과 어긋나면 실패한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMarketOpen, marketBadge, type MarketId } from '../src/lib/marketHours.ts'

// [시장, UTC 시각, 기대값, 설명]. 2026-10-16은 금요일, 미국은 서머타임(EDT, UTC-4) 기간이다.
const CASES: [MarketId, string, boolean, string][] = [
  ['krx', '2026-10-16T01:00:00Z', true, '금 10:00 KST'],
  ['krx', '2026-10-15T23:59:00Z', false, '금 08:59 KST (개장 전)'],
  ['krx', '2026-10-16T06:29:00Z', true, '금 15:29 KST'],
  ['krx', '2026-10-16T06:30:00Z', false, '금 15:30 KST (마감)'],
  ['krx', '2026-10-17T01:00:00Z', false, '토 10:00 KST'],
  ['us_equity', '2026-10-16T13:30:00Z', true, '금 09:30 EDT (개장)'],
  ['us_equity', '2026-10-16T13:29:00Z', false, '금 09:29 EDT'],
  ['us_equity', '2026-10-16T20:00:00Z', false, '금 16:00 EDT (마감)'],
  ['us_equity', '2026-12-15T14:30:00Z', true, '화 09:30 EST (서머타임 끝난 뒤)'],
  ['us_equity', '2026-12-15T14:29:00Z', false, '화 09:29 EST'],
  ['global_24h', '2026-10-14T16:00:00Z', true, '수 12:00 EDT'],
  ['global_24h', '2026-10-16T20:59:00Z', true, '금 16:59 EDT'],
  ['global_24h', '2026-10-16T21:00:00Z', false, '금 17:00 EDT (주간 마감)'],
  ['global_24h', '2026-10-17T16:00:00Z', false, '토 12:00 EDT'],
  ['global_24h', '2026-10-18T21:59:00Z', false, '일 17:59 EDT'],
  ['global_24h', '2026-10-18T22:00:00Z', true, '일 18:00 EDT (주간 개장)'],
  // 도쿄(JST, UTC+9)·대만(UTC+8), 서머타임 없음 (D-67, T-105)
  ['tokyo', '2026-10-16T00:00:00Z', true, '금 09:00 JST (개장)'],
  ['tokyo', '2026-10-16T02:29:00Z', true, '금 11:29 JST'],
  ['tokyo', '2026-10-16T02:30:00Z', false, '금 11:30 JST (점심 휴장)'],
  ['tokyo', '2026-10-16T03:30:00Z', true, '금 12:30 JST (오후 개장)'],
  ['tokyo', '2026-10-16T06:30:00Z', false, '금 15:30 JST (마감)'],
  ['tokyo', '2026-10-17T01:00:00Z', false, '토 10:00 JST'],
  ['taiwan', '2026-10-16T01:00:00Z', true, '금 09:00 대만 (개장)'],
  ['taiwan', '2026-10-16T05:29:00Z', true, '금 13:29 대만'],
  ['taiwan', '2026-10-16T05:30:00Z', false, '금 13:30 대만 (마감)'],
  ['taiwan', '2026-10-16T00:59:00Z', false, '금 08:59 대만'],
  // 국내 특수 거래일 (T-166)
  ['krx', '2026-11-19T00:30:00Z', false, '수능일 09:30 KST (1시간 늦게 개장)'],
  ['krx', '2026-11-19T01:00:00Z', true, '수능일 10:00 KST (개장)'],
  ['krx', '2026-11-19T07:29:00Z', true, '수능일 16:29 KST'],
  ['krx', '2026-11-19T07:30:00Z', false, '수능일 16:30 KST (마감)'],
  ['krx', '2026-11-20T00:00:00Z', true, '수능 다음 날 09:00 KST (평소대로)'],
  ['krx', '2027-01-04T00:30:00Z', false, '새해 첫 거래일 09:30 KST'],
  ['krx', '2027-01-04T01:00:00Z', true, '새해 첫 거래일 10:00 KST (개장)'],
  ['krx', '2027-01-04T06:30:00Z', false, '새해 첫 거래일 15:30 KST (마감)'],
]

for (const [market, iso, expected, label] of CASES) {
  test(`${market}: ${label} → ${expected ? '열림' : '닫힘'}`, () => {
    assert.equal(isMarketOpen(market, new Date(iso)), expected)
  })
}

// 공휴일 반영 배지 (T-56): backend의 decideMarketStatus와 같은 규칙
test('marketBadge: 장 시간 밖이면 소스와 상관없이 장 마감', () => {
  assert.deepEqual(marketBadge(false, 'REGULAR'), { label: '장 마감', open: false })
})

test('marketBadge: 장 시간 + 소스 REGULAR 또는 정보 없음 → 장중', () => {
  assert.deepEqual(marketBadge(true, 'REGULAR'), { label: '장중', open: true })
  assert.deepEqual(marketBadge(true, undefined), { label: '장중', open: true })
})

test('marketBadge: 장 시간인데 소스가 닫혀 있으면 휴장, PRE/POST는 장 시작 전/장 마감', () => {
  assert.deepEqual(marketBadge(true, 'CLOSED'), { label: '휴장', open: false })
  assert.deepEqual(marketBadge(true, 'PRE'), { label: '장 시작 전', open: false })
  assert.deepEqual(marketBadge(true, 'POST'), { label: '장 마감', open: false })
})
