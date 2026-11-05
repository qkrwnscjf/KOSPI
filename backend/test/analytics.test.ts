// 15단계 분석 카테고리 테스트: 종목 순위(T-113), 실적·배당 캘린더(T-111), 파이프라인 상태(T-112)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankStocks, STOCK_FIELDS } from '../src/infrastructure/krx/krx-breadth.js';
import { closeTimestamp } from '../src/infrastructure/krx/krx-index-daily.js';
import { parseStockRankings } from '../src/shared/rankings.js';
import { isCalendarDate, isCalendarMonth, nextDay, nextMonthStart } from '../src/shared/disclosure-calendar.js';
import { dbJobName, parseVector } from '../src/shared/prometheus.js';

const stock = (code: string, name: string, rate: string, value: string, cap: string) => ({
  [STOCK_FIELDS.code]: code, [STOCK_FIELDS.name]: name, [STOCK_FIELDS.close]: '10,000',
  [STOCK_FIELDS.changeRate]: rate, [STOCK_FIELDS.value]: value, [STOCK_FIELDS.marketCap]: cap, [STOCK_FIELDS.change]: '0',
});

test('rankStocks: 4가지 순위를 매기고, 여러 순위에 든 종목은 한 행에 순위를 함께 담는다', () => {
  const result = rankStocks('KOSPI', '20261023', [
    stock('000001', '가', '5.00', '300', '1,000'),
    stock('000002', '나', '-3.00', '100', '3,000'),
    stock('000003', '다', '1.00', '200', '2,000'),
    stock('000004', '라', '0.00', '0', '-'),
  ], 2);
  assert.ok(result);
  assert.equal(result.time, closeTimestamp('20261023'));
  const byCode = Object.fromEntries(result.entries.map(entry => [entry.code, entry.ranks]));
  assert.deepEqual(byCode['000001'], { gain: 1, value: 1 });
  assert.deepEqual(byCode['000002'], { loss: 1, cap: 1 });
  assert.deepEqual(byCode['000003'], { gain: 2, value: 2, cap: 2 });
  assert.equal(byCode['000004'], undefined); // 보합·거래대금 0·시총 없음 → 어느 순위에도 없음
});

test('rankStocks: 코드·이름·종가가 잘못된 행은 빼고, 쓸 행이 없으면 null', () => {
  assert.equal(rankStocks('KOSDAQ', '20261023', [stock('bad', '가', '1', '1', '1'), { ...stock('000001', '', '1', '1', '1') }]), null);
});

test('parseStockRankings: 알려진 형식만 통과, 중복 코드·잘못된 순위는 거부', () => {
  const entry = { code: '005930', name: '삼성전자', close: 70000, changeRate: 1.2, tradingValue: 1e12, marketCap: 4e14, ranks: { cap: 1 } };
  const ok = parseStockRankings(Buffer.from(JSON.stringify({ market: 'KOSPI', time: 1_790_000_000_000, entries: [entry], extra: 'x' })));
  assert.equal(ok.ok, true);
  const bad = (entries: unknown[]) => parseStockRankings(Buffer.from(JSON.stringify({ market: 'KOSPI', time: 1_790_000_000_000, entries })));
  assert.deepEqual(bad([entry, entry]), { ok: false, reason: 'code' });
  assert.deepEqual(bad([{ ...entry, ranks: { cap: 101 } }]), { ok: false, reason: 'ranks' });
  assert.deepEqual(bad([{ ...entry, ranks: {} }]), { ok: false, reason: 'ranks' });
  assert.deepEqual(bad([{ ...entry, code: '<script>' }]), { ok: false, reason: 'code' });
  assert.deepEqual(parseStockRankings(Buffer.from(JSON.stringify({ market: 'NYSE', time: 1_790_000_000_000, entries: [entry] }))), { ok: false, reason: 'market' });
});

test('캘린더 날짜: 형식과 실제 날짜만 통과, 예외를 던지지 않음', () => {
  assert.equal(isCalendarMonth('2026-10'), true);
  assert.equal(isCalendarMonth('2026-13'), false);
  assert.equal(isCalendarDate('2026-02-28'), true);
  assert.equal(isCalendarDate('2026-02-30'), false);
  assert.equal(isCalendarDate('2026-10-1'), false);
  assert.equal(isCalendarDate(undefined), false);
  assert.equal(nextMonthStart('2026-12'), '2027-01-01');
  assert.equal(nextMonthStart('2026-09'), '2026-10-01');
  assert.equal(nextDay('2026-10-31'), '2026-11-01');
});

test('parseVector · dbJobName: Prometheus 응답 해석, exported_job 우선', () => {
  const body = { status: 'success', data: { resultType: 'vector', result: [
    { metric: { job: 'db-sink', exported_job: 'retention:market_ticks' }, value: [1, '0'] },
    { metric: { job: 'worker' }, value: [1, 'NaN'] },
  ] } };
  const samples = parseVector(body);
  assert.equal(samples?.length, 1);
  assert.equal(dbJobName(samples![0]!.labels), 'retention:market_ticks');
  assert.equal(parseVector({ status: 'error' }), null);
  assert.equal(parseVector(null), null);
});
