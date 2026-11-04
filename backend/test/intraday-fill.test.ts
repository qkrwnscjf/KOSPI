// 1일·1주 그래프 공백 채우기 테스트 (docs/Task_ORDER.md T-151)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillDue, findGap, needsFill, toFillRows, FILL_REFETCH_MS } from '../src/infrastructure/sink/intraday-fill.js';
import { parseYahooBar } from '../src/shared/yahoo-bars.js';
import { replayDecision } from '../src/infrastructure/sink/dlq-replay.js';
import { TOPICS } from '../src/infrastructure/kafka.js';

const FIVE_MIN = 5 * 60_000;
const HOUR = 60 * 60_000;
const at = (iso: string) => Date.parse(iso);

// 2026-11-05(목) 15:00 KST = 06:00 UTC, 국내 장중
const NOW = at('2026-11-05T06:00:00Z');

function slots(from: number, to: number, step: number) {
  const result: number[] = [];
  for (let slot = from; slot <= to; slot += step) result.push(slot);
  return result;
}

test('findGap: 장이 열린 칸이 모두 있으면 공백이 아니다', () => {
  const gap = findGap(slots(NOW - 24 * HOUR, NOW, FIVE_MIN), 'krx', '5m', NOW);
  assert.deepEqual(gap, { missing: 0, longestRun: 0 });
  assert.equal(needsFill(gap, '5m'), false);
});

test('findGap: 장이 닫힌 시간에 값이 없는 것은 공백이 아니다', () => {
  // 국내: 어제 15:00 KST부터 오늘 15:00 KST까지. 장 시간의 칸만 채운다
  const openOnly = slots(NOW - 24 * HOUR, NOW, FIVE_MIN).filter(slot => {
    const utcMinutes = new Date(slot).getUTCHours() * 60 + new Date(slot).getUTCMinutes();
    return utcMinutes < 6 * 60 + 30; // 00:00 ~ 06:30 UTC = 09:00 ~ 15:30 KST
  });
  assert.equal(findGap(openOnly, 'krx', '5m', NOW).missing, 0);
});

test('findGap: 장중 15분 이상 비면 채울 대상이고, 그보다 짧으면 아니다', () => {
  const all = slots(NOW - 24 * HOUR, NOW, FIVE_MIN);
  const without = (from: string, to: string) => all.filter(slot => slot < at(from) || slot >= at(to));
  // 11:00 ~ 11:15 KST = 3칸
  const long = findGap(without('2026-11-05T02:00:00Z', '2026-11-05T02:15:00Z'), 'krx', '5m', NOW);
  assert.equal(long.longestRun, 3);
  assert.equal(needsFill(long, '5m'), true);
  // 2칸은 얇은 거래로 비는 정도로 본다
  const short = findGap(without('2026-11-05T02:00:00Z', '2026-11-05T02:10:00Z'), 'krx', '5m', NOW);
  assert.equal(short.longestRun, 2);
  assert.equal(needsFill(short, '5m'), false);
});

test('findGap: 집계가 아직 만들어지는 최근 구간은 공백으로 보지 않는다', () => {
  const nowLate = at('2026-11-05T05:00:00Z'); // 14:00 KST
  // 13:50 KST 이후가 비어 있어도 마지막 15분 안의 칸은 세지 않는다: 13:50, 13:55만 비었으나 14:00 - 15분 = 13:45까지만 본다
  const existing = slots(nowLate - 24 * HOUR, at('2026-11-05T04:45:00Z'), FIVE_MIN);
  assert.equal(findGap(existing, 'krx', '5m', nowLate).missing, 0);
  // 1시간 봉은 최근 2시간 10분을 보지 않는다
  const hourly = slots(nowLate - 7 * 24 * HOUR, at('2026-11-05T02:00:00Z'), HOUR);
  assert.equal(findGap(hourly, 'krx', '1h', nowLate).missing, 0);
});

test('findGap: 1시간 봉은 한 칸만 비어도 채울 대상이다', () => {
  const missingHour = at('2026-11-04T02:00:00Z'); // 수요일 11:00 KST
  const existing = slots(NOW - 7 * 24 * HOUR, NOW, HOUR).filter(slot => slot !== missingHour);
  const gap = findGap(existing, 'krx', '1h', NOW);
  assert.deepEqual(gap, { missing: 1, longestRun: 1 });
  assert.equal(needsFill(gap, '1h'), true);
});

test('findGap: 마지막으로 받을 때 이미 끝난 빈 칸은 다시 받아도 채워지지 않으므로 보지 않는다', () => {
  const all = slots(NOW - 24 * HOUR, NOW, FIVE_MIN);
  // 11:00 ~ 11:30 KST가 비어 있다 (Yahoo에도 없는 칸이라고 가정)
  const existing = all.filter(slot => slot < at('2026-11-05T02:00:00Z') || slot >= at('2026-11-05T02:30:00Z'));
  assert.equal(findGap(existing, 'krx', '5m', NOW).longestRun, 6);
  assert.equal(findGap(existing, 'krx', '5m', NOW, at('2026-11-05T03:00:00Z')).missing, 0);
});

test('findGap: 마지막으로 받은 뒤에 새로 생긴 공백은 채울 대상이다', () => {
  const lastFetched = at('2026-11-05T01:00:00Z');
  // 10:05 KST 이후 스택이 꺼져 있었다
  const existing = slots(NOW - 24 * HOUR, lastFetched, FIVE_MIN);
  const gap = findGap(existing, 'krx', '5m', NOW, lastFetched);
  assert.ok(gap.longestRun >= 3);
  assert.equal(needsFill(gap, '5m'), true);
});

test('findGap: 받을 때 진행 중이던 칸은 아직 요청해 본 칸이 아니다', () => {
  // 10:02 KST에 받았다면 10:00 칸의 봉은 끝나지 않아 받지 못했다
  const lastFetched = at('2026-11-05T01:02:00Z');
  const existing = slots(NOW - 24 * HOUR, at('2026-11-05T00:55:00Z'), FIVE_MIN);
  const nowSoon = at('2026-11-05T01:20:00Z');
  // 10:00, 10:05 칸만 볼 수 있다 (10:20 - 15분 = 10:05까지)
  assert.equal(findGap(existing, 'krx', '5m', nowSoon, lastFetched).missing, 2);
});

test('fillDue: 같은 지표는 20시간에 한 번만 다시 받는다', () => {
  assert.equal(fillDue(undefined, NOW), true);
  assert.equal(fillDue(NOW - FILL_REFETCH_MS + 1, NOW), false);
  assert.equal(fillDue(NOW - FILL_REFETCH_MS, NOW), true);
});

test('toFillRows: 정각에 시작하는 봉은 시작 시각의 버킷에 넣는다', () => {
  const rows = toFillRows([
    { date: new Date('2026-11-05T01:00:00Z'), close: 100 },
    { date: new Date('2026-11-05T02:00:00Z'), close: 101 },
  ], '1h', NOW);
  assert.deepEqual(rows, [
    { time: at('2026-11-05T01:00:00Z'), close: 100 },
    { time: at('2026-11-05T02:00:00Z'), close: 101 },
  ]);
});

test('toFillRows: 미국 60분 봉(09:30 시작)은 종가 시각이 속한 10:00 버킷에 넣는다', () => {
  const rows = toFillRows([{ date: new Date('2026-11-04T14:30:00Z'), close: 7000 }], '1h', NOW);
  assert.deepEqual(rows, [{ time: at('2026-11-04T15:00:00Z'), close: 7000 }]);
});

test('toFillRows: 아직 끝나지 않은 봉은 넣지 않는다', () => {
  const rows = toFillRows([
    { date: new Date(NOW - 2 * FIVE_MIN), close: 100 },
    { date: new Date(NOW - FIVE_MIN), close: 101 }, // 지금 막 끝남
    { date: new Date(NOW - 60_000), close: 102 },   // 진행 중
  ], '5m', NOW);
  assert.deepEqual(rows.map(row => row.close), [100, 101]);
});

test('toFillRows: 응답 끝의 현재가(분 단위가 아닌 시각)와 값 없는 봉은 넣지 않는다', () => {
  const rows = toFillRows([
    { date: new Date('2026-11-04T06:25:00Z'), close: 100 },
    { date: new Date('2026-11-04T06:30:17Z'), close: 105 },
    { date: new Date('2026-11-04T06:20:00Z'), close: null },
    { date: new Date('2026-11-04T06:15:00Z'), close: 0 },
    { date: new Date('2026-11-04T06:10:00Z'), close: -1 },
    { date: new Date('2026-11-04T06:05:00Z') },
  ], '5m', NOW);
  assert.deepEqual(rows, [{ time: at('2026-11-04T06:25:00Z'), close: 100 }]);
});

test('toFillRows: 시각 순서로 돌려준다', () => {
  const rows = toFillRows([
    { date: new Date('2026-11-04T06:10:00Z'), close: 2 },
    { date: new Date('2026-11-04T06:05:00Z'), close: 1 },
  ], '5m', NOW);
  assert.deepEqual(rows.map(row => row.close), [1, 2]);
});

const bar = (fields: Record<string, unknown>) => Buffer.from(JSON.stringify({ symbol: 'KOSPI', resolution: '5m', time: at('2026-11-05T01:00:00Z'), close: 4000, ...fields }));

test('parseYahooBar: 정상 메시지', () => {
  const parsed = parseYahooBar(bar({ producedAt: NOW }));
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.row, { symbol: 'KOSPI', resolution: '5m', time: at('2026-11-05T01:00:00Z'), close: 4000, producedAt: NOW });
});

test('parseYahooBar: 잘못된 메시지는 예외 없이 사유를 돌려준다', () => {
  const reasonOf = (value: Buffer | null) => {
    const parsed = parseYahooBar(value);
    return parsed.ok ? 'ok' : parsed.reason;
  };
  assert.equal(reasonOf(null), 'empty');
  assert.equal(reasonOf(Buffer.from('{')), 'invalid_json');
  assert.equal(reasonOf(Buffer.from('[]')), 'not_object');
  assert.equal(reasonOf(bar({ symbol: 'NOPE' })), 'symbol');
  assert.equal(reasonOf(bar({ resolution: '1d' })), 'resolution');
  assert.equal(reasonOf(bar({ time: at('2026-11-05T01:01:00Z') })), 'time');
  assert.equal(reasonOf(bar({ resolution: '1h', time: at('2026-11-05T01:05:00Z') })), 'time');
  assert.equal(reasonOf(bar({ close: 0 })), 'close');
  assert.equal(reasonOf(bar({ close: 'x' })), 'close');
  assert.equal(reasonOf(bar({ producedAt: -1 })), 'produced_at');
});

test('DLQ 다시 처리: yahoo-bars도 지금의 검증 규칙으로 판단한다', () => {
  assert.deepEqual(replayDecision(TOPICS.yahooBars, bar({})), { replay: true });
  assert.deepEqual(replayDecision(TOPICS.yahooBars, bar({ close: 0 })), { replay: false, reason: 'close' });
});
