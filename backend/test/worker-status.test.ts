// worker 상태 점검·주기 로그 요약 시험 (plan.md P3-2 · P3-5, docs/Task_ORDER.md T-212 · T-214, BENCHMARK B-85 · B-86)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCycleSummary, YAHOO_UNHEALTHY_FAILURES, yahooFetchHealthy } from '../src/infrastructure/ingestion/worker-status.js';

test('T-212: 장중 연속 실패 5번이면 yahoo_fetch 실패, 4번은 정상, 장 밖이면 실패가 많아도 정상', () => {
  assert.equal(YAHOO_UNHEALTHY_FAILURES, 5);
  assert.equal(yahooFetchHealthy(0, true), true);
  assert.equal(yahooFetchHealthy(4, true), true);
  assert.equal(yahooFetchHealthy(5, true), false);
  assert.equal(yahooFetchHealthy(50, false), true);
});

test('T-214: 주기 로그는 1분에 한 줄 요약(주기 수·실패·받은 수·새 tick·보낸 수)', () => {
  let now = 0;
  const summary = createCycleSummary(60_000, () => now);
  const lines: string[] = [];
  // 5초 주기 24번 = 2분
  for (let cycle = 1; cycle <= 24; cycle += 1) {
    now = cycle * 5_000;
    const line = summary.add({ received: 10, fresh: 3, sent: 3, failed: cycle === 2 });
    if (line) lines.push(line);
  }
  assert.equal(lines.length, 2, '24주기(2분)에 2줄. 예전에는 주기마다 2 ~ 3줄')
  assert.equal(lines[0], 'Cycles in the last 60s: 12 (failed 1), items received 120, new ticks 36, sent 36');
  assert.equal(lines[1], 'Cycles in the last 60s: 12 (failed 0), items received 120, new ticks 36, sent 36');
});
