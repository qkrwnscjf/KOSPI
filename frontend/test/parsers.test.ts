// REST 응답 검증 테스트 (docs/Task_ORDER.md T-165, BENCHMARK B-68)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBreadth, parseCapitalEvents, parseDisclosurePage, parseHistory, parseSectorReturns } from '../src/lib/parsers.ts'

test('parseHistory: 숫자가 아닌 점은 버리고, not_ready는 그대로 알린다', () => {
  assert.deepEqual(parseHistory({ data: [{ time: 1, value: 2 }, { time: '1', value: 2 }, { time: 3, value: null }] }), { points: [{ time: 1, value: 2 }], notReady: false })
  assert.deepEqual(parseHistory({ data: [], status: 'not_ready' }), { points: [], notReady: true })
  assert.equal(parseHistory('x'), null)
})

test('parseSectorReturns: 수익률은 숫자 또는 null만 받는다', () => {
  const good = { symbol: 'KRX_SEMI', returnPct: null, last: 1, dayChangeRate: 0, lastTime: 1, points: 1 }
  assert.equal(parseSectorReturns({ data: [good, { ...good, returnPct: '3' }] })?.length, 1)
  assert.equal(parseSectorReturns(null), null)
})

test('parseBreadth: 시장별 배열만 받고 한쪽이 없으면 빈 배열', () => {
  const point = { time: 1, advancers: 1, decliners: 2, unchanged: 3, stocks: 6, tradingValue: 10 }
  assert.deepEqual(parseBreadth({ data: { KOSPI: [point, { ...point, stocks: 'x' }] } }), { KOSPI: [point], KOSDAQ: [] })
  assert.equal(parseBreadth({}), null)
})

const disclosure = { rceptNo: '20261107000001', rceptDate: '2026-11-07', stockCode: '005930', corpName: 'A', reportName: 'B', group: 'other', kind: 'other', isCorrection: false, amount: null }

test('parseDisclosurePage: 필드가 빠진 공시는 버리고, 범위 값은 정해진 두 가지만', () => {
  const page = parseDisclosurePage({ data: [disclosure, { ...disclosure, corpName: 1 }], scope: 'unknown' })
  assert.equal(page?.items.length, 1)
  assert.deepEqual(page?.scope, { scope: 'kospi_all', scopeAsOf: null })
})

test('parseCapitalEvents: 숫자가 빠진 묶음은 버린다', () => {
  const bucket = { date: '2026-11-07', dilution: 1, shareholderReturn: 0, treasuryDisposal: 0, dilutionCount: 1, shareholderReturnCount: 0, treasuryDisposalCount: 0, missingAmountCount: 0 }
  const events = parseCapitalEvents({ bucket: 'week', buckets: [bucket, { ...bucket, dilution: 'x' }], top: [disclosure], since: '2026-10-07' })
  assert.equal(events?.bucket, 'week')
  assert.equal(events?.buckets.length, 1)
  assert.equal(events?.top.length, 1)
})
