// 지표별 시장 표 일치 시험 (plan.md QA-30 / P4-1, docs/Task_ORDER.md T-208, BENCHMARK B-81)
// frontend/test/marketTable.test.ts와 같은 사례다. 백엔드 YAHOO_MARKET이 화면 카드 표와 어긋나면 한쪽이 실패한다.
// 두 벌 표는 plan.md P5-1(설정을 백엔드 REST로)에서 하나로 줄인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YAHOO_MARKET, type MarketId } from '../src/infrastructure/ingestion/market-hours.js';

// frontend/test/marketTable.test.ts EXPECTED_MARKET과 같은 값(27개)
const EXPECTED_MARKET: Record<string, MarketId> = {
  KOSPI: 'krx', KOSDAQ: 'krx', KOSPI200: 'krx', SAMSUNG: 'krx', SK_HYNIX: 'krx', HYUNDAI: 'krx',
  SP500: 'us_equity', NASDAQ: 'us_equity', SOX: 'us_equity', DOW: 'us_equity', RUSSELL: 'us_equity',
  US10Y: 'us_equity', US13W: 'us_equity', US5Y: 'us_equity', US30Y: 'us_equity',
  VIX: 'global_24h',
  NIKKEI: 'tokyo', TAIEX: 'taiwan',
  'USD/KRW': 'global_24h', 'JPY/KRW': 'global_24h', 'CNY/KRW': 'global_24h', DXY: 'global_24h',
  WTI: 'global_24h', COPPER: 'global_24h', GOLD: 'global_24h', BRENT: 'global_24h', NATGAS: 'global_24h',
};

test('YAHOO_MARKET이 화면 카드와 같은 시장 표다 (27개)', () => {
  assert.deepEqual({ ...YAHOO_MARKET }, EXPECTED_MARKET);
});
