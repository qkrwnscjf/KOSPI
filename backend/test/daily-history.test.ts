// 나중에 추가한 Yahoo 지표의 과거 일봉 테스트 (docs/Task_ORDER.md T-104 ③, D-67)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAP_FILL_DAYS, missingWeekdays, needsDailyHistory, toDailyRows, usesOfficialDailyClose } from '../src/infrastructure/sink/daily-history.js';
import { nextCollectDelay, RETRY_AFTER_ERROR_MS } from '../src/infrastructure/market-stats/collect-schedule.js';
import { YAHOO_KEYS } from '../src/shared/symbols.js';
import { setWallClockTimeout } from '../src/infrastructure/wall-clock-timer.js';
import { internalGaps } from '../src/infrastructure/krx/krx-index-daily.js';
import { datesToCheck } from '../src/infrastructure/krx/krx-schedule.js';
import { parseYahooDaily } from '../src/shared/yahoo-daily.js';
import { replayDecision } from '../src/infrastructure/sink/dlq-replay.js';
import { TOPICS } from '../src/infrastructure/kafka.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('setWallClockTimeout: 잠자기로 시계가 건너뛰면 다음 확인 때 바로 실행한다 (T-140)', async () => {
  let clock = 1_000_000;
  let fired = 0;
  setWallClockTimeout(() => { fired += 1; }, 3600_000, () => clock, 2);
  await wait(15);
  assert.equal(fired, 0); // 아직 시각 전
  clock += 3600_000; // 깨어나 보니 1시간이 지남
  await wait(15);
  assert.equal(fired, 1);
  await wait(15);
  assert.equal(fired, 1); // 한 번만
});

test('setWallClockTimeout: 취소하면 실행하지 않는다 (T-140)', async () => {
  let clock = 1_000_000;
  let fired = 0;
  const timer = setWallClockTimeout(() => { fired += 1; }, 1000, () => clock, 2);
  timer.cancel();
  clock += 5000;
  await wait(15);
  assert.equal(fired, 0);
});

test('internalGaps: 저장된 첫날과 마지막 날 사이의 빈 날만 (T-141)', () => {
  const target = ['20261026', '20261027', '20261028', '20261029', '20261030', '20261102', '20261103'];
  // 오늘 집계(11/3)가 먼저 생겨도 10/29·10/30·11/2를 찾는다
  assert.deepEqual(internalGaps(target, [new Set(['20261027', '20261028', '20261103'])]), ['20261029', '20261030', '20261102']);
  assert.deepEqual(internalGaps(target, [new Set(target)]), []);
  assert.deepEqual(internalGaps(target, [new Set()]), []); // 저장된 것이 없으면 missingDates가 맡음
});

test('datesToCheck: 확인한 적 없는 날짜는 뒤 날짜를 먼저 받았어도 받고, 비어 있던 날짜만 휴장으로 본다 (T-141)', () => {
  const now = Date.parse('2026-11-03T10:00:00Z');
  const dates = ['20261028', '20261029', '20261102'];
  const received = new Map([['20261102', { receivedAt: now - 1000 }]]);
  assert.deepEqual(datesToCheck(dates, received, now), ['20261028', '20261029']);
  const emptyThenReceived = new Map([['20261029', { lastEmptyAt: now - 2 * 3600_000 }], ['20261102', { receivedAt: now - 1000 }]]);
  assert.deepEqual(datesToCheck(dates, emptyThenReceived, now), ['20261028']);
});

test('parseYahooDaily: 정상 메시지와 잘못된 값 (T-143)', () => {
  const good = { symbol: 'SP500', time: 1_793_000_000_000, close: 7000.5, changeRate: 0.1, changePrice: 7, overwrite: true, producedAt: 1_793_000_000_001 };
  const parse = (value: unknown) => parseYahooDaily(Buffer.from(JSON.stringify(value)));
  assert.deepEqual(parse(good), { ok: true, row: good });
  assert.deepEqual(parse({ ...good, symbol: 'KRX_SEMI' }), { ok: false, reason: 'symbol' }); // Yahoo 심볼만
  assert.deepEqual(parse({ ...good, close: 0 }), { ok: false, reason: 'close' });
  assert.deepEqual(parse({ ...good, changeRate: null }), { ok: false, reason: 'change_rate' });
  assert.deepEqual(parse({ ...good, overwrite: 'yes' }), { ok: false, reason: 'overwrite' });
  assert.deepEqual(parseYahooDaily(Buffer.from('{')), { ok: false, reason: 'invalid_json' });
  assert.deepEqual(parseYahooDaily(null), { ok: false, reason: 'empty' });
});

test('DLQ 다시 처리: yahoo-daily 메시지도 지금 검증으로 판단한다 (T-143)', () => {
  const value = Buffer.from(JSON.stringify({ symbol: 'SP500', time: 1_793_000_000_000, close: 7000.5, changeRate: 0.1, changePrice: 7, overwrite: false }));
  assert.deepEqual(replayDecision(TOPICS.yahooDaily, value), { replay: true });
  assert.deepEqual(replayDecision(TOPICS.yahooDaily, Buffer.from('{}')), { replay: false, reason: 'symbol' });
});

test('usesOfficialDailyClose: 장 시간이 정해진 시장 17종만, 24시간 시장(환율·원자재·VIX)은 제외 (T-136)', () => {
  const official = YAHOO_KEYS.filter(usesOfficialDailyClose);
  assert.equal(official.length, 17);
  assert.ok(official.includes('KOSPI') && official.includes('SP500') && official.includes('NIKKEI'));
  assert.ok(!official.includes('USD/KRW') && !official.includes('VIX') && !official.includes('GOLD'));
});

test('nextCollectDelay: 첫 일시 실패는 30분 뒤, 이어지면 2배씩, 키·한도 문제는 하루 (T-137)', () => {
  const six = 6 * 3600_000;
  const day = 24 * 3600_000;
  assert.deepEqual(nextCollectDelay(['ok', 'ok'], 0, six, day), { delayMs: six, failures: 0 });
  assert.deepEqual(nextCollectDelay(['error', 'ok'], 0, six, day), { delayMs: RETRY_AFTER_ERROR_MS, failures: 1 });
  assert.deepEqual(nextCollectDelay(['error', 'ok'], 1, six, day), { delayMs: 2 * six, failures: 2 });
  assert.deepEqual(nextCollectDelay(['error', 'ok'], 2, six, day), { delayMs: day, failures: 3 });
  assert.deepEqual(nextCollectDelay(['pause', 'ok'], 0, six, day), { delayMs: day, failures: 0 });
  assert.deepEqual(nextCollectDelay(['ok', 'ok'], 3, six, day), { delayMs: six, failures: 0 });
});
import { closeTimestamp } from '../src/infrastructure/krx/krx-index-daily.js';

const bar = (iso: string, price: number) => ({ time: new Date(iso), price, changeRate: 1, changePrice: 2 });

test('일봉 시각은 서울 거래일의 15:30 KST(KRX 일별 값과 같은 기준)로 맞춘다', () => {
  // Yahoo 일봉 시각이 서울 자정(전날 15:00 UTC)이든 개장 시각(00:00 UTC)이든 같은 거래일로 본다
  const rows = toDailyRows([bar('2026-10-19T15:00:00Z', 100), bar('2026-10-21T00:00:00Z', 101)], Date.parse('2026-10-23T03:00:00Z'));
  assert.deepEqual(rows.map(row => row.time), [closeTimestamp('20261020'), closeTimestamp('20261021')]);
  assert.equal(rows[0]?.close, 100);
});

test('시작한 지 24시간이 안 된 봉은 장중 값일 수 있어 넣지 않는다', () => {
  const now = Date.parse('2026-10-23T03:00:00Z'); // 금 12:00 KST
  const rows = toDailyRows([bar('2026-10-22T00:00:00Z', 100), bar('2026-10-23T00:00:00Z', 105)], now);
  assert.deepEqual(rows.map(row => row.time), [closeTimestamp('20261022')]);
});

test('서울 날짜가 지났어도 미국 장의 진행 중인 봉은 넣지 않는다', () => {
  const now = Date.parse('2026-10-22T16:40:00Z'); // 금 01:40 KST, 미국 목요일 장중
  const rows = toDailyRows([bar('2026-10-21T13:30:00Z', 100), bar('2026-10-22T13:30:00Z', 101)], now);
  assert.deepEqual(rows.map(row => row.close), [100]);
});

test('needsDailyHistory: 일봉이나 집계가 없으면 받는다', () => {
  const now = Date.parse('2026-10-23T03:00:00Z');
  assert.equal(needsDailyHistory(null, null, now), true);
  assert.equal(needsDailyHistory(closeTimestamp('20261021'), null, now), true);
  assert.equal(needsDailyHistory(null, Date.parse('2026-10-23T00:00:00Z'), now), true);
});

test('needsDailyHistory: 마지막 일봉과 집계 첫날 사이에 평일이 비어 있을 때만 다시 받는다 (이음매)', () => {
  const now = Date.parse('2026-10-23T03:00:00Z');
  const firstAgg = Date.parse('2026-10-23T00:00:00Z'); // 금요일 집계 시작
  assert.equal(needsDailyHistory(closeTimestamp('20261021'), firstAgg, now), true);  // 목(10/22)이 빔
  assert.equal(needsDailyHistory(closeTimestamp('20261022'), firstAgg, now), false); // 이어짐
  // 금요일 일봉 → 월요일 집계 시작: 사이가 주말뿐이라 받지 않음
  assert.equal(needsDailyHistory(closeTimestamp('20261023'), Date.parse('2026-10-26T00:00:00Z'), Date.parse('2026-10-26T03:00:00Z')), false);
});

test(`needsDailyHistory: 집계가 시작된 지 ${GAP_FILL_DAYS}일이 지나면 더 받지 않는다 (공휴일·일봉 없는 지표)`, () => {
  const firstAgg = Date.parse('2026-10-01T00:00:00Z');
  const later = firstAgg + (GAP_FILL_DAYS + 1) * 86_400_000;
  assert.equal(needsDailyHistory(null, firstAgg, later), false);
  assert.equal(needsDailyHistory(closeTimestamp('20260925'), firstAgg, later), false);
});

test('missingWeekdays: 집계·일봉 모두에 없는 평일만, 주말·최근 이틀·집계 시작 전은 빼고 (T-127)', () => {
  const now = Date.parse('2026-10-27T03:00:00Z'); // 화요일
  const agg = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-21', '2026-10-22'];
  const daily = ['2026-10-23'];
  // 10/20(화) 빠짐. 10/23은 일봉으로 있음. 10/26(월)·10/27(화)은 최근 이틀이라 보지 않음. 10/13 이전은 집계 시작 전
  assert.deepEqual(missingWeekdays(agg, daily, '2026-10-14', now), ['2026-10-20']);
  assert.deepEqual(missingWeekdays(agg, [], '2026-10-14', now), ['2026-10-20', '2026-10-23']);
  assert.deepEqual(missingWeekdays([], [], null, now), []); // 집계가 없으면 이음매 규칙이 맡음
});

test('같은 날짜가 두 번 오면 마지막 값을 쓰고, 날짜 순으로 정렬한다', () => {
  const rows = toDailyRows([bar('2026-10-21T00:00:00Z', 101), bar('2026-10-20T00:00:00Z', 100), bar('2026-10-21T05:00:00Z', 102)], Date.parse('2026-10-23T03:00:00Z'));
  assert.deepEqual(rows.map(row => row.close), [100, 102]);
});
