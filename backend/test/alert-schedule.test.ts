// 알림 기준 ↔ 수집 일정 대조 시험 (plan.md QA-21 · QA-42 / P6-2 축소, docs/Task_ORDER.md T-226, BENCHMARK B-100)
// QA-21(KRX 알림 3시간이 실제 일정과 맞지 않아 밤·주말마다 거짓 알림)은 사람이 읽어서만 찾았다.
// 알림 규칙 파일의 기준값이 코드의 수집 일정(평소 최대 공백)보다 큰지 확인한다. 대조 함수가 틀린 기준을 잡는지도 함께 본다.
// 알림 규칙 파일은 backend Docker 빌드 범위(./backend) 밖이라, 파일을 읽는 시험은 저장소 전체가 있는 CI·개발 환경에서만 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { latestSessionEnd, type MarketId } from '../src/infrastructure/ingestion/market-hours.js';
import { MARKET_STATS_DEFAULT_INTERVAL_MS } from '../src/infrastructure/market-stats/collect-schedule.js';
import { DART_DEFAULT_INTERVALS } from '../src/infrastructure/disclosures/dart-disclosures.js';
import { EMPTY_RECHECK_MS, KRX_DEFAULT_POLLING_INTERVAL_MS } from '../src/infrastructure/krx/krx-schedule.js';

const ALERTS_PATH = fileURLToPath(new URL('../../monitoring/grafana/provisioning/alerting/kospi-alerts.yml', import.meta.url));
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

// 공식 종가: 마감 30분 뒤부터 받고(backfill.ts, latestSessionEnd의 margin), db-sink가 30분마다 확인한다(db-sink.ts CLOSE_REFRESH_CHECK_MS)
const OFFICIAL_CLOSE_MARGIN_MS = 30 * MINUTE_MS;
const OFFICIAL_CLOSE_CHECK_MS = 30 * MINUTE_MS;
const SESSION_MARKETS: MarketId[] = ['krx', 'us_equity', 'tokyo', 'taiwan'];

// 기준이 평소 최대 공백보다 커야 거짓 알림이 나지 않는다
const covers =(thresholdMs: number, normalMaxGapMs: number) => thresholdMs > normalMaxGapMs;

// 시간표로 계산한, 연속한 두 장 마감 사이의 가장 긴 간격(평소: 금요일 → 월요일). 공휴일은 시간표에 없어 포함하지 않는다
function maxSessionGapMs(market: MarketId, fromMs: number, toMs: number): number {
  let previous: number | null = null;
  let maxGap = 0;
  for (let now = fromMs; now <= toMs; now += 15 * MINUTE_MS) {
    const end = latestSessionEnd(market, now, OFFICIAL_CLOSE_MARGIN_MS);
    if (end === null) continue;
    if (previous !== null && end !== previous) maxGap = Math.max(maxGap, end - previous);
    previous = end;
  }
  return maxGap;
}

function ruleBlock(yml: string, uid: string): string {
  const start = yml.indexOf(`- uid: ${uid}`);
  assert.ok(start >= 0, `알림 규칙 ${uid}가 없음`);
  const next = yml.indexOf('- uid:', start + 1);
  return yml.slice(start, next < 0 ? undefined : next);
}
const thresholdSeconds = (block: string) => {
  const match = /evaluator: \{ type: gt, params: \[(\d+)\] \}/.exec(block);
  assert.ok(match?.[1], '기준값(gt)이 없음');
  return Number(match[1]);
};
const rangeWindowHours = (block: string) => [...block.matchAll(/\[(\d+)h\]/g)].map(match => Number(match[1]));

test('대조 함수: 평소 공백보다 작거나 같은 기준은 잡는다(일부러 틀린 값)', () => {
  assert.equal(covers(72 * HOUR_MS, 72 * HOUR_MS + OFFICIAL_CLOSE_CHECK_MS), false, '공식 종가 72시간: 주말을 못 넘음');
  assert.equal(covers(3 * HOUR_MS, 6 * HOUR_MS), false, 'KRX 예전 기준 3시간 vs 저녁 1회 일정(QA-21)과 같은 종류');
  assert.equal(covers(78 * HOUR_MS, 72.5 * HOUR_MS), true);
});

test('장 시간표의 평소 최대 마감 간격은 금요일 → 월요일 72시간(4개 시장, 11월 4주)', () => {
  const from = Date.UTC(2026, 10, 2);
  const to = Date.UTC(2026, 10, 30);
  for (const market of SESSION_MARKETS) {
    assert.equal(maxSessionGapMs(market, from, to), 72 * HOUR_MS, market);
  }
});

const hasAlerts = existsSync(ALERTS_PATH);
const skip = hasAlerts ? false : '알림 규칙 파일이 빌드 범위 밖(backend Docker 빌드) — CI에서 확인';

test('알림 ↔ 일정: 공식 종가 중단 기준이 가장 긴 평소 공백(주말 + 확인 주기)보다 큼', { skip }, () => {
  const yml = readFileSync(ALERTS_PATH, 'utf8');
  const threshold = thresholdSeconds(ruleBlock(yml, 'kospi-official-close-stale')) * 1000;
  const gap = Math.max(...SESSION_MARKETS.map(market => maxSessionGapMs(market, Date.UTC(2026, 10, 2), Date.UTC(2026, 10, 30))));
  assert.ok(covers(threshold, gap + OFFICIAL_CLOSE_CHECK_MS), `기준 ${threshold / HOUR_MS}시간 ≤ 평소 공백 ${(gap + OFFICIAL_CLOSE_CHECK_MS) / HOUR_MS}시간`);
});

test('알림 ↔ 일정: 증시 자금 흐름 기준이 정상 주기 2번보다 크고, 실패 집계 창과 같은 길이', { skip }, () => {
  const block = ruleBlock(readFileSync(ALERTS_PATH, 'utf8'), 'kospi-market-stats-stale');
  const threshold = thresholdSeconds(block) * 1000;
  assert.ok(covers(threshold, 2 * MARKET_STATS_DEFAULT_INTERVAL_MS), `기준 ${threshold / HOUR_MS}시간`);
  assert.deepEqual(rangeWindowHours(block), [threshold / HOUR_MS], '식의 [Nh] 창 = 기준 시간');
});

test('알림 ↔ 일정: DART 기준이 장 밖 조회 주기 2번보다 큼', { skip }, () => {
  const threshold = thresholdSeconds(ruleBlock(readFileSync(ALERTS_PATH, 'utf8'), 'kospi-dart-stale')) * 1000;
  assert.ok(covers(threshold, 2 * DART_DEFAULT_INTERVALS.idleMs), `기준 ${threshold / MINUTE_MS}분`);
});

test('알림 ↔ 일정: KRX 창이 확인 주기·빈 날짜 재확인 주기의 2번 이상이고, 조회 범위와 식의 창이 같음', { skip }, () => {
  const block = ruleBlock(readFileSync(ALERTS_PATH, 'utf8'), 'kospi-krx-stale');
  const windows = rangeWindowHours(block);
  assert.ok(windows.length >= 2 && windows.every(hours => hours === windows[0]), '식의 [Nh] 창이 모두 같음');
  const windowMs = (windows[0] ?? 0) * HOUR_MS;
  const range = /relativeTimeRange: \{ from: (\d+), to: 0 \}/.exec(block);
  assert.equal(Number(range?.[1]) * 1000, windowMs, '조회 범위 = 식의 창');
  assert.ok(windowMs >= 2 * Math.max(KRX_DEFAULT_POLLING_INTERVAL_MS, EMPTY_RECHECK_MS), `창 ${windowMs / HOUR_MS}시간 안에 호출이 2번 이상`);
});
