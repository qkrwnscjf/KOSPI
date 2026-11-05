// 시장 폭·거래대금 테스트 (docs/Task_ORDER.md T-106)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeBreadth, STOCK_FIELDS } from '../src/infrastructure/krx/krx-breadth.js';
import { closeTimestamp, pastSeoulWeekdays } from '../src/infrastructure/krx/krx-index-daily.js';
import { parseMarketBreadth } from '../src/shared/breadth.js';
import { symbolForIndexName, isKrxDailySymbol, isKrxHistorySymbol } from '../src/shared/krx-indices.js';
import { isYahooSymbolKey } from '../src/shared/symbols.js';

const row = (close: string, change: string, rate: string, value: string) => ({
  [STOCK_FIELDS.close]: close, [STOCK_FIELDS.change]: change, [STOCK_FIELDS.changeRate]: rate, [STOCK_FIELDS.value]: value,
  ISU_NM: '종목', ISU_CD: '000000',
});

test('summarizeBreadth: 등락률 부호로 상승·하락·보합을 세고 거래대금을 더한다. 기준 시각은 15:30 KST', () => {
  const { breadth, invalid } = summarizeBreadth('KOSPI', '20261022', [
    row('10,000', '500', '5.26', '1,000,000'),
    row('5,000', '-100', '-1.96', '2,000,000'),
    row('7,000', '0', '0.00', '0'),
  ]);
  assert.equal(invalid, 0);
  assert.deepEqual(breadth, {
    market: 'KOSPI', time: closeTimestamp('20261022'), advancers: 1, decliners: 1, unchanged: 1, stocks: 3, tradingValue: 3_000_000,
  });
});

test('summarizeBreadth: 값이 빠진 종목은 0으로 채우지 않고 합계에서 뺀다', () => {
  const { breadth, invalid } = summarizeBreadth('KOSDAQ', '20261022', [
    row('10,000', '500', '5.26', '1,000'),
    row('-', '-', '-', '-'),        // 거래정지 등으로 값 없음
    row('5,000', '100', '2.04', ''), // 거래대금 없음
  ]);
  assert.equal(invalid, 2);
  assert.equal(breadth?.stocks, 1);
  assert.equal(breadth?.tradingValue, 1000);
});

test('summarizeBreadth: 등락률이 0.00으로 반올림되면 대비 부호를 쓴다 (대비가 부호를 가진 형식일 때만)', () => {
  const signed = summarizeBreadth('KOSPI', '20261022', [
    row('1,000,000', '10', '0.00', '1'),
    row('2,000', '-5', '-0.25', '1'),
  ]);
  assert.equal(signed.breadth?.advancers, 1);
  // 대비에 음수가 하나도 없으면 부호 없는 형식일 수 있어 방향을 알 수 없으므로 보합
  const unsigned = summarizeBreadth('KOSPI', '20261022', [
    row('1,000,000', '10', '0.00', '1'),
    row('2,000', '5', '0.25', '1'),
  ]);
  assert.deepEqual([unsigned.breadth?.advancers, unsigned.breadth?.unchanged], [1, 1]);
});

test('summarizeBreadth: 쓸 수 있는 행이 없으면 null (휴장일·필드 이름 불일치)', () => {
  assert.equal(summarizeBreadth('KOSPI', '20261022', []).breadth, null);
  assert.equal(summarizeBreadth('KOSPI', '20261022', [{ OTHER: '1' }]).breadth, null);
});

test('parseMarketBreadth: 알려진 형식만 통과하고, 종목 수 합이 맞아야 한다', () => {
  const ok = { market: 'KOSPI', time: 1_790_000_000_000, advancers: 1, decliners: 2, unchanged: 3, stocks: 6, tradingValue: 10 };
  const parsed = parseMarketBreadth(Buffer.from(JSON.stringify({ ...ok, extra: 'x' })));
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.breadth, ok);
  assert.deepEqual(parseMarketBreadth(Buffer.from(JSON.stringify({ ...ok, market: 'NASDAQ' }))), { ok: false, reason: 'market' });
  assert.deepEqual(parseMarketBreadth(Buffer.from(JSON.stringify({ ...ok, stocks: 7 }))), { ok: false, reason: 'stocks' });
  assert.deepEqual(parseMarketBreadth(Buffer.from(JSON.stringify({ ...ok, advancers: -1 }))), { ok: false, reason: 'counts' });
  assert.deepEqual(parseMarketBreadth(Buffer.from(JSON.stringify({ ...ok, tradingValue: -1 }))), { ok: false, reason: 'trading_value' });
  assert.deepEqual(parseMarketBreadth(Buffer.from('not-json')), { ok: false, reason: 'invalid_json' });
});

test('pastSeoulWeekdays: 오늘은 빼고, 주말에도 금요일을 빠뜨리지 않는다', () => {
  const sunday = Date.parse('2026-10-25T03:00:00Z'); // 일 12:00 KST
  assert.deepEqual(pastSeoulWeekdays(sunday, 4), ['20261021', '20261022', '20261023']); // 토·일 제외, 금요일 포함
  const friday = Date.parse('2026-10-23T03:00:00Z'); // 금 12:00 KST
  assert.deepEqual(pastSeoulWeekdays(friday, 2), ['20261021', '20261022']);
});

test('코스피 200 과거 일봉(T-104 보완): KOSPI 시리즈에서만 이름이 맞고, KRX 일별 카드가 아닌 Yahoo 지표다', () => {
  assert.equal(symbolForIndexName('kospi', '코스피 200'), 'KOSPI200');
  assert.equal(symbolForIndexName('kospi', '코스피 200 정보기술'), undefined);
  assert.equal(symbolForIndexName('krx', '코스피 200'), undefined);
  assert.equal(isKrxHistorySymbol('KOSPI200'), true);
  assert.equal(isKrxDailySymbol('KOSPI200'), false); // History API가 Yahoo 경로(집계 + 과거 일봉)로 보낸다
  assert.equal(isYahooSymbolKey('KOSPI200'), true);
});
