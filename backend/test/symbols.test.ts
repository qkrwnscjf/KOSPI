// 심볼 허용 목록 테스트 (docs/Task_ORDER.md T-45, SEC-005)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DERIVED_SPREADS, YAHOO_DAILY_HISTORY_KEYS, YAHOO_KEYS, isDerivedSymbol, isSubscribableSymbol, isYahooSymbolKey } from '../src/shared/symbols.js';
import { KRX_DAILY_KEYS } from '../src/shared/krx-indices.js';
import { parseTick } from '../src/shared/tick-validation.js';

test('알려진 Yahoo 27종 + KRX 일별 21종만 구독할 수 있다 (D-67: Yahoo 10 → 27, 홍콩·상해·비트코인 제외)', () => {
  for (const symbol of [...YAHOO_KEYS, ...KRX_DAILY_KEYS]) {
    assert.equal(isSubscribableSymbol(symbol), true, symbol);
  }
  assert.equal(YAHOO_KEYS.length, 27);
  assert.equal(KRX_DAILY_KEYS.length, 21);
});

test('과거 일봉으로 채우는 지표는 처음 10종을 뺀 나중 추가 17종이다 (T-104 ③)', () => {
  const original = ['KOSPI', 'KOSDAQ', 'USD/KRW', 'DXY', 'US10Y', 'SP500', 'NASDAQ', 'SOX', 'WTI', 'COPPER'];
  for (const key of YAHOO_DAILY_HISTORY_KEYS) assert.equal(isYahooSymbolKey(key), true, key);
  assert.deepEqual([...YAHOO_DAILY_HISTORY_KEYS].sort(), YAHOO_KEYS.filter(key => !original.includes(key)).sort());
});

test('계산 지표(장단기 금리차)는 구독 방이 없고, 재료는 Yahoo 지표다 (T-107)', () => {
  assert.equal(isDerivedSymbol('US_SPREAD'), true);
  assert.equal(isSubscribableSymbol('US_SPREAD'), false);
  assert.equal(isDerivedSymbol('constructor'), false);
  for (const { long, short } of Object.values(DERIVED_SPREADS)) {
    assert.equal(isYahooSymbolKey(long), true);
    assert.equal(isYahooSymbolKey(short), true);
  }
});

test('목록에 없는 값, 문자열이 아닌 값, 객체 속성 이름은 거부한다', () => {
  for (const value of ['kospi', '', 'BTC', '__proto__', 'constructor', 'toString', 123, null, undefined, ['KOSPI'], { symbol: 'KOSPI' }]) {
    assert.equal(isSubscribableSymbol(value), false, String(value));
  }
  assert.equal(isYahooSymbolKey('constructor'), false);
  assert.equal(isYahooSymbolKey('VKOSPI'), false);
});

test('데이터 원천이 없는 투자자별 흐름 방은 구독할 수 없다 (T-164)', () => {
  for (const room of ['flows:KOSPI', 'flows:KOSDAQ', 'flows:']) assert.equal(isSubscribableSymbol(room), false, room);
  assert.equal(isSubscribableSymbol('disclosures:KOSPI'), true);
});

test('Yahoo와 KRX 일별 심볼 이름이 겹치지 않는다', () => {
  const yahoo = new Set<string>(YAHOO_KEYS);
  assert.deepEqual(KRX_DAILY_KEYS.filter(key => yahoo.has(key)), []);
});

test('구독 가능한 심볼은 모두 Kafka 메시지 검증의 심볼 형식을 통과한다', () => {
  for (const symbol of [...YAHOO_KEYS, ...KRX_DAILY_KEYS]) {
    const tick = { symbol, category: 'domestic', price: 1, changeRate: 0, timestamp: 1_790_000_000_000 };
    assert.equal(parseTick(Buffer.from(JSON.stringify(tick))).ok, true, symbol);
  }
});
