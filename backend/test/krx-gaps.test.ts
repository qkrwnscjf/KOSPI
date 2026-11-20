// KRX 실패 날짜·빈 지표 시험 (plan.md P2-3 · QA-10 · 11 · 12, docs/Task_ORDER.md T-216, BENCHMARK B-88)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineCoverage, coverageSymbols, internalGaps, missingDates } from '../src/infrastructure/krx/krx-index-daily.js';
import { nextRetryAttempt, RETRY_LIMITS, selectRetryDates } from '../src/infrastructure/krx/krx-schedule.js';
import { parseBreadthCoverage } from '../src/infrastructure/backend-coverage.js';

const WINDOW = ['20261102', '20261103', '20261104', '20261105', '20261106', '20261109', '20261110'];

test('① 지표 하나의 저장 날짜 사이에 빠진 날은 채울 날짜에 들어간다 (재기동해도 DB 기준으로 다시 찾음)', () => {
  const full = new Set(WINDOW);
  const missingOne = new Set(WINDOW.filter(date => date !== '20261105'));
  // 저장 범위(앞뒤)만 보는 예전 방식은 빠진 날을 찾지 못한다
  const stored = combineCoverage([{ earliest: '20261102', latest: '20261110' }, { earliest: '20261102', latest: '20261110' }]);
  assert.deepEqual(missingDates(WINDOW, stored), []);
  assert.deepEqual(internalGaps(WINDOW, [full, missingOne]), ['20261105']);
});

test('① 시장 폭 응답의 행 날짜(서울)로 저장 날짜를 만든다', () => {
  const at = (date: string) => Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T06:30:00Z`);
  const body = {
    data: { KOSPI: ['20261102', '20261103', '20261106'].map(date => ({ time: at(date) })), KOSDAQ: [] },
    coverage: { KOSPI: { since: '2026-11-02', until: '2026-11-06' }, KOSDAQ: null },
  };
  const parsed = parseBreadthCoverage(body, ['KOSPI', 'KOSDAQ']);
  const kospi = parsed?.get('KOSPI');
  assert.ok(kospi);
  assert.deepEqual([...kospi.days].sort(), ['20261102', '20261103', '20261106']);
  assert.deepEqual(internalGaps(['20261102', '20261103', '20261104', '20261105', '20261106'], [kospi.days]), ['20261104', '20261105']);
  assert.equal(parsed?.get('KOSDAQ'), null);
});

test('② 저장값 없는 지표가 KRX 응답에 없으면(이름 변경) 빼고 계산, 있으면(새 지표) 지금처럼 전체 채우기', () => {
  const symbols = ['A', 'B', 'RENAMED'];
  const hasStored = (symbol: string) => symbol !== 'RENAMED';
  const renamed = coverageSymbols(symbols, hasStored, new Set(['A', 'B']));
  assert.deepEqual(renamed, { usable: ['A', 'B'], absent: ['RENAMED'] });
  const stored = { earliest: '20251120', latest: '20261118' };
  const target = ['20251120', '20251121', '20261118'];
  assert.deepEqual(missingDates(target, combineCoverage(renamed.usable.map(() => stored))), [], '다른 지표가 다 있으면 채울 날짜 0');
  // 예전: 빈 지표 때문에 null → 1년 전체
  assert.deepEqual(missingDates(target, combineCoverage([stored, stored, null])), target);

  const added = coverageSymbols(symbols, hasStored, new Set(['A', 'B', 'RENAMED']));
  assert.deepEqual(added, { usable: symbols, absent: [] });
  assert.equal(combineCoverage([stored, stored, null]), null, '새 지표는 지금처럼 전체 채우기');

  assert.deepEqual(coverageSymbols(symbols, () => false, new Set()), { usable: symbols, absent: [] }, '모두 비어 있으면(첫 기동) 그대로');
});

test('③ 재시도: 같은 날짜 3번 실패 뒤 빠짐, 한 주기 최근 20개, 60일보다 오래된 날짜 빠짐', () => {
  assert.equal(RETRY_LIMITS.maxAttempts, 3);
  assert.deepEqual(nextRetryAttempt(undefined), { attempts: 1, keep: true });
  assert.deepEqual(nextRetryAttempt(1), { attempts: 2, keep: true });
  assert.deepEqual(nextRetryAttempt(2), { attempts: 3, keep: false });

  // 첫 과거 채우기가 260일 모두 실패한 경우
  const retry = new Map<string, number>();
  for (let day = 0; day < 260; day += 1) {
    const date = new Date(Date.UTC(2026, 10, 20) - day * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
    retry.set(date, 1);
  }
  const selected = [...selectRetryDates(retry, '20261120')].sort();
  assert.equal(selected.length, 20, '예전에는 260개를 매 주기');
  assert.equal(selected[selected.length - 1], '20261120', '최근 날짜부터');
  assert.ok(selected.every(date => date >= '20260921'));
  assert.deepEqual([...selectRetryDates(new Map([['20260901', 1]]), '20261120')], [], '60일보다 오래됨');
  assert.deepEqual([...selectRetryDates(undefined, '20261120')], []);
});
