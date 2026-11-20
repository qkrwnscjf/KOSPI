// 미국 조기 폐장 시험 (plan.md P2-7 · QA-17, docs/Task_ORDER.md T-219, BENCHMARK B-91)
// frontend/test/usEarlyClose.test.ts와 같은 사례다. 표의 날짜는 시험용(실제 표는 거래소 공지 확인 전이라 비어 있음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUsEquityOpen, latestSessionEnd, MARKETS, US_EARLY_CLOSES } from '../src/infrastructure/ingestion/market-hours.js';

const TEST_TABLE = { '2026-11-27': { close: 13 * 60 } }; // 시험용: 금요일 13:00 ET(EST, UTC-5) = 18:00 UTC

test('① 표에 있는 날은 13:00 ET부터 미국 장이 닫힌다 (12:59는 열림)', () => {
  assert.equal(isUsEquityOpen(new Date('2026-11-27T17:59:00Z'), TEST_TABLE), true);
  assert.equal(isUsEquityOpen(new Date('2026-11-27T18:00:00Z'), TEST_TABLE), false);
  assert.equal(isUsEquityOpen(new Date('2026-11-27T18:00:00Z'), {}), true, '표가 없으면 16:00까지');
  assert.equal(isUsEquityOpen(new Date('2026-11-30T18:00:00Z'), TEST_TABLE), true, '표에 없는 날은 그대로');
});

test('② 그날 공식 종가 기준 마감 시각은 13:00 ET', () => {
  const now = Date.parse('2026-11-27T19:00:00Z');
  assert.equal(latestSessionEnd('us_equity', now, 30 * 60_000, TEST_TABLE), Date.parse('2026-11-27T18:00:00Z'));
  // 표가 없으면 그날 장이 아직 안 끝난 것으로 보고 전날(목) 16:00 ET
  assert.equal(latestSessionEnd('us_equity', now, 30 * 60_000, {}), Date.parse('2026-11-26T21:00:00Z'));
});

test('③ ④ 실제 표는 비어 있어(날짜 확인 전) 지금 동작은 그대로', () => {
  assert.deepEqual(US_EARLY_CLOSES, {});
  const usEquity = MARKETS.find(market => market.id === 'us_equity');
  assert.equal(usEquity?.isOpen(new Date('2026-11-27T18:00:00Z')), true);
  assert.equal(latestSessionEnd('us_equity', Date.parse('2026-11-27T19:00:00Z'), 30 * 60_000), Date.parse('2026-11-26T21:00:00Z'));
});
