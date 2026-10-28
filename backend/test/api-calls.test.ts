// 외부 API 호출 줄이기 테스트: Yahoo 요청 심볼(T-131), KRX 확인 일정(T-132), 재시작 중복 방지 응답 해석(T-133)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSE_GRACE_MS, FULL_REFRESH_MS, planYahooRequest } from '../src/infrastructure/ingestion/request-plan.js';
import { YAHOO_MARKET } from '../src/infrastructure/ingestion/market-hours.js';
import { YAHOO_KEYS } from '../src/shared/symbols.js';
import { datesToCheck, EMPTY_RECHECK_MS, recordCheck, RECHECK_AFTER_MS, type DateCheckState } from '../src/infrastructure/krx/krx-schedule.js';
import { parseLatestTickTimes } from '../src/infrastructure/backend-coverage.js';

const now = Date.parse('2026-10-28T02:00:00Z'); // 수 11:00 KST

test('planYahooRequest: 처음과 60초마다는 전체, 그 사이에는 닫힌 시장 지표를 뺀다', () => {
  const statuses = { krx: 'open', us_equity: 'closed', global_24h: 'open', tokyo: 'open', taiwan: 'holiday' } as const;
  assert.equal(planYahooRequest(statuses, new Map(), undefined, now).full, true);
  assert.equal(planYahooRequest(statuses, new Map(), now - FULL_REFRESH_MS, now).keys.length, YAHOO_KEYS.length);

  const plan = planYahooRequest(statuses, new Map(), now - 5_000, now);
  assert.equal(plan.full, false);
  assert.ok(plan.keys.every(key => YAHOO_MARKET[key] !== 'us_equity'));
  // 휴장 판단 중인 시장(대만)은 개장을 알아채야 해서 요청한다
  assert.ok(plan.keys.includes('TAIEX'));
  assert.equal(plan.keys.length, YAHOO_KEYS.filter(key => YAHOO_MARKET[key] !== 'us_equity').length);
});

test('planYahooRequest: 방금 닫힌 시장은 30분 동안 요청하고, 모두 닫히면 전체를 요청한다', () => {
  const statuses = { krx: 'closed', us_equity: 'closed', global_24h: 'open', tokyo: 'closed', taiwan: 'closed' } as const;
  const justClosed = new Map([['krx', now - 10 * 60_000]] as const);
  assert.ok(planYahooRequest(statuses, justClosed, now - 5_000, now).keys.includes('KOSPI'));
  const longAgo = new Map([['krx', now - CLOSE_GRACE_MS]] as const);
  assert.ok(!planYahooRequest(statuses, longAgo, now - 5_000, now).keys.includes('KOSPI'));

  const allClosed = { krx: 'closed', us_equity: 'closed', global_24h: 'closed', tokyo: 'closed', taiwan: 'closed' } as const;
  assert.deepEqual(planYahooRequest(allClosed, new Map(), now - 5_000, now), { keys: [...YAHOO_KEYS], full: true });
});

test('datesToCheck: 기준일 18시 전에는 받지 않고, 받은 날짜는 20시간 뒤 한 번만 다시 받는다', () => {
  const dates = ['20261026', '20261027', '20261028'];
  const empty = new Map<string, DateCheckState>();
  // 10/28 11:00 KST: 오늘(10/28)은 아직, 지난 날짜는 받는다
  assert.deepEqual(datesToCheck(dates, empty, now), ['20261026', '20261027']);

  const states = new Map<string, DateCheckState>([
    ['20261026', recordCheck(undefined, 'rows', now)],
    ['20261027', recordCheck(undefined, 'rows', now)],
  ]);
  assert.deepEqual(datesToCheck(dates, states, now + 60_000), []); // 받은 뒤 바로는 다시 받지 않음
  const later = now + RECHECK_AFTER_MS;
  assert.deepEqual(datesToCheck(dates, states, later), ['20261026', '20261027', '20261028']); // 정정 확인 1회 + 18시 지난 오늘
  states.set('20261026', recordCheck(states.get('20261026'), 'rows', later));
  assert.ok(!datesToCheck(dates, states, later + RECHECK_AFTER_MS).includes('20261026')); // 정정 확인은 한 번만
});

test('datesToCheck: 빈 날짜는 1시간에 한 번만, 뒤 날짜가 받아졌으면 휴장일로 보고 그만 확인한다', () => {
  const evening = Date.parse('2026-10-28T10:00:00Z'); // 19:00 KST
  const dates = ['20261027', '20261028'];
  const states = new Map<string, DateCheckState>([['20261028', recordCheck(undefined, 'empty', evening)]]);
  assert.deepEqual(datesToCheck(dates, states, evening + 60_000), ['20261027']);
  assert.deepEqual(datesToCheck(dates, states, evening + EMPTY_RECHECK_MS), ['20261027', '20261028']);

  const holiday = new Map<string, DateCheckState>([
    ['20261027', recordCheck(undefined, 'empty', evening)],
    ['20261028', recordCheck(undefined, 'rows', evening)],
  ]);
  assert.deepEqual(datesToCheck(dates, holiday, evening + EMPTY_RECHECK_MS), []);
});

test('parseLatestTickTimes: 시각이 숫자인 항목만, 장 상태는 알려진 값만 받는다', () => {
  const parsed = parseLatestTickTimes({
    data: [
      { symbol: 'KOSPI', timestamp: 1, marketState: 'CLOSED' },
      { symbol: 'SP500', timestamp: 2, marketState: 'weird' },
      { symbol: 'DOW', timestamp: 'x' },
      null,
    ],
  });
  assert.deepEqual(parsed, [{ symbol: 'KOSPI', timestamp: 1, marketState: 'CLOSED' }, { symbol: 'SP500', timestamp: 2 }]);
  assert.equal(parseLatestTickTimes({ data: 'nope' }), null);
});
