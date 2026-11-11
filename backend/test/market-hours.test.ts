// 장 시간 판단 테스트 (docs/Task_ORDER.md T-45, T-07, D-16)
// frontend/test/marketHours.test.ts에 같은 사례가 있다. 두 파일의 규칙이 어긋나면 한쪽이 실패한다 (D-36).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KRX_SPECIAL_SESSIONS, MARKETS, YAHOO_MARKET, decideMarketStatus, latestSessionEnd, type MarketId } from '../src/infrastructure/ingestion/market-hours.js';
import { YAHOO_KEYS } from '../src/shared/symbols.js';

const isOpen = (market: MarketId, iso: string) => {
  const found = MARKETS.find(item => item.id === market);
  assert.ok(found, market);
  return found.isOpen(new Date(iso));
};

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
];

for (const [market, iso, expected, label] of CASES) {
  test(`${market}: ${label} → ${expected ? '열림' : '닫힘'}`, () => {
    assert.equal(isOpen(market, iso), expected);
  });
}

// 공휴일 반영 (T-56, D-40): 시간표와 소스 장 상태를 합친 판단
test('decideMarketStatus: 장 시간 밖이면 소스와 상관없이 closed', () => {
  assert.equal(decideMarketStatus(false, ['REGULAR']), 'closed');
  assert.equal(decideMarketStatus(false, []), 'closed');
});

test('decideMarketStatus: 장 시간 + 소스 REGULAR(하나라도) → open', () => {
  assert.equal(decideMarketStatus(true, ['REGULAR', 'REGULAR']), 'open');
  assert.equal(decideMarketStatus(true, ['CLOSED', 'REGULAR']), 'open');
});

test('decideMarketStatus: 장 시간 + 소스 장 상태를 모르면 이전처럼 open (시간표로 대체)', () => {
  assert.equal(decideMarketStatus(true, []), 'open');
  assert.equal(decideMarketStatus(true, [undefined, undefined]), 'open');
});

test('decideMarketStatus: 장 시간인데 소스가 모두 닫혀 있으면 holiday (공휴일)', () => {
  assert.equal(decideMarketStatus(true, ['CLOSED', 'CLOSED']), 'holiday');
  assert.equal(decideMarketStatus(true, ['CLOSED', undefined]), 'holiday');
  assert.equal(decideMarketStatus(true, ['PRE', 'POST']), 'holiday');
});

test('latestSessionEnd: 수능일은 16:30 마감이라 공식 종가를 17:00부터 받는다 (T-166)', () => {
  const margin = 30 * 60_000;
  const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString().slice(0, 16));
  // 수능일 16:10 KST: 평소라면 마감 + 30분이 지났지만 아직 장중이라 전날(수) 장
  assert.equal(iso(latestSessionEnd('krx', Date.parse('2026-11-19T07:10:00Z'), margin)), '2026-11-18T06:30');
  // 수능일 17:00 KST: 그날 16:30 마감
  assert.equal(iso(latestSessionEnd('krx', Date.parse('2026-11-19T08:00:00Z'), margin)), '2026-11-19T07:30');
  // 다음 날 10:00 KST: 직전 장은 수능일(16:30 마감)
  assert.equal(iso(latestSessionEnd('krx', Date.parse('2026-11-20T01:00:00Z'), margin)), '2026-11-19T07:30');
});

test('KRX_SPECIAL_SESSIONS: 날짜 형식과 시간 범위가 올바르다 (T-166)', () => {
  for (const [date, session] of Object.entries(KRX_SPECIAL_SESSIONS)) {
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, date);
    assert.ok(session.open < session.close, date);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    assert.ok(weekday >= 1 && weekday <= 5, `${date}는 평일이어야 한다`);
  }
});

test('모든 Yahoo 지표에 시장이 지정되어 있다', () => {
  for (const key of YAHOO_KEYS) {
    assert.ok(YAHOO_MARKET[key], key);
  }
});
