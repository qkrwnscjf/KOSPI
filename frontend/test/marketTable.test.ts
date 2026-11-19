// 지표별 시장 표 일치 시험 (plan.md QA-30 / P4-1, docs/Task_ORDER.md T-208, BENCHMARK B-81)
// backend/test/market-table.test.ts와 같은 사례다. 화면 카드(constants/data.ts)의 market이 백엔드 YAHOO_MARKET과 어긋나면 실패한다.
// 두 벌 표는 plan.md P5-1(설정을 백엔드 REST로)에서 하나로 줄인다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CATEGORY_DATA } from '../src/constants/data.ts'
import { isMarketOpen, type MarketId } from '../src/lib/marketHours.ts'

// backend/src/infrastructure/ingestion/market-hours.ts YAHOO_MARKET과 같은 값(27개)
const EXPECTED_MARKET: Record<string, MarketId> = {
  KOSPI: 'krx', KOSDAQ: 'krx', KOSPI200: 'krx', SAMSUNG: 'krx', SK_HYNIX: 'krx', HYUNDAI: 'krx',
  SP500: 'us_equity', NASDAQ: 'us_equity', SOX: 'us_equity', DOW: 'us_equity', RUSSELL: 'us_equity',
  US10Y: 'us_equity', US13W: 'us_equity', US5Y: 'us_equity', US30Y: 'us_equity',
  VIX: 'global_24h',
  NIKKEI: 'tokyo', TAIEX: 'taiwan',
  'USD/KRW': 'global_24h', 'JPY/KRW': 'global_24h', 'CNY/KRW': 'global_24h', DXY: 'global_24h',
  WTI: 'global_24h', COPPER: 'global_24h', GOLD: 'global_24h', BRENT: 'global_24h', NATGAS: 'global_24h',
}

const cards = Object.values(CATEGORY_DATA).flat()

test('실시간 카드의 market이 백엔드 지표 시장 표와 같다', () => {
  const mismatched = cards
    .filter(card => card.market !== undefined && card.spread === undefined)
    .filter(card => card.market !== EXPECTED_MARKET[card.symbol])
    .map(card => `${card.symbol}: ${card.market} (백엔드 ${EXPECTED_MARKET[card.symbol] ?? '없음'})`)
  assert.deepEqual(mismatched, [])
})

test('백엔드 표의 27개 지표가 모두 화면 카드에 있다', () => {
  const shown = new Set(cards.filter(card => card.market !== undefined).map(card => card.symbol))
  assert.deepEqual(Object.keys(EXPECTED_MARKET).filter(symbol => !shown.has(symbol)), [])
})

test('계산 카드(금리차)는 두 지표와 같은 시장을 쓴다', () => {
  for (const card of cards.filter(item => item.spread !== undefined)) {
    assert.equal(EXPECTED_MARKET[card.spread!.long], card.market, card.symbol)
    assert.equal(EXPECTED_MARKET[card.spread!.short], card.market, card.symbol)
  }
})

test('VIX 카드는 미국 주식 장 밖에도 24시간 시장 시간표를 따른다', () => {
  const vix = cards.find(card => card.symbol === 'VIX')
  assert.ok(vix?.market)
  // 2026-11-17(화) 03:30 EST: 미국 주식 장 밖, 24시간 시장 장중
  assert.equal(isMarketOpen(vix.market, new Date('2026-11-17T08:30:00Z')), true)
  // 2026-11-21(토) 12:00 EST: 24시간 시장도 주말 휴장
  assert.equal(isMarketOpen(vix.market, new Date('2026-11-21T17:00:00Z')), false)
})
