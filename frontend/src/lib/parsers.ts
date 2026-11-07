// REST 응답 검증 (docs/Task_ORDER.md T-165, D-92)
// 이전에는 일부 훅만 검증 함수를 쓰고 나머지는 배열인지만 보고 그대로 썼다. 이제 모든 응답이 이 함수들을 거친다.
// 형식이 맞지 않는 항목은 버리고, 응답 자체가 틀리면 null(오류)을 돌려준다.
// 테스트할 수 있도록 React와 분리한 순수 함수다. 타입만 가져오므로 실행 때 다른 모듈을 불러오지 않는다.

import type { ChartPoint } from './chartPoints'
import type { BreadthMarket, BreadthPoint } from './breadth'
import type { SectorReturn } from './sectors'
import type { DisclosureItem } from './disclosures'

type Rec = Record<string, unknown>
const asRecord = (value: unknown): Rec | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null)
const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isStr = (value: unknown): value is string => typeof value === 'string'
const listOf = <T>(value: unknown, pick: (item: Rec) => T | null): T[] =>
  Array.isArray(value) ? value.flatMap(item => {
    const record = asRecord(item)
    const picked = record ? pick(record) : null
    return picked === null ? [] : [picked]
  }) : []

// 그래프 (`/market/history`, `/market/recent`). not_ready는 수집 보류 중인 지표
export interface HistoryResult { points: ChartPoint[]; notReady: boolean }
export function parseHistory(body: unknown): HistoryResult | null {
  const record = asRecord(body)
  if (!record) return null
  if (record.status === 'not_ready') return { points: [], notReady: true }
  return { points: listOf(record.data, item => (isNum(item.time) && isNum(item.value) ? { time: item.time, value: item.value } : null)), notReady: false }
}

export function parseSectorReturns(body: unknown): SectorReturn[] | null {
  const record = asRecord(body)
  if (!record) return null
  return listOf(record.data, item =>
    isStr(item.symbol) && isNum(item.last) && isNum(item.dayChangeRate) && isNum(item.lastTime) && isNum(item.points) && (item.returnPct === null || isNum(item.returnPct))
      ? { symbol: item.symbol, returnPct: item.returnPct as number | null, last: item.last, dayChangeRate: item.dayChangeRate, lastTime: item.lastTime, points: item.points }
      : null)
}

export type BreadthData = Record<BreadthMarket, BreadthPoint[]>
const breadthPoint = (item: Rec): BreadthPoint | null =>
  isNum(item.time) && isNum(item.advancers) && isNum(item.decliners) && isNum(item.unchanged) && isNum(item.stocks) && isNum(item.tradingValue)
    ? { time: item.time, advancers: item.advancers, decliners: item.decliners, unchanged: item.unchanged, stocks: item.stocks, tradingValue: item.tradingValue }
    : null
export function parseBreadth(body: unknown): BreadthData | null {
  const data = asRecord(asRecord(body)?.data)
  if (!data) return null
  return { KOSPI: listOf(data.KOSPI, breadthPoint), KOSDAQ: listOf(data.KOSDAQ, breadthPoint) }
}

export const disclosureItem = (item: Rec): DisclosureItem | null =>
  isStr(item.rceptNo) && isStr(item.rceptDate) && isStr(item.stockCode) && isStr(item.corpName) && isStr(item.reportName)
    && isStr(item.group) && isStr(item.kind) && typeof item.isCorrection === 'boolean' && (item.amount === null || isNum(item.amount))
    ? {
        rceptNo: item.rceptNo, rceptDate: item.rceptDate, stockCode: item.stockCode, corpName: item.corpName, reportName: item.reportName,
        group: item.group, kind: item.kind, isCorrection: item.isCorrection, amount: item.amount as number | null,
      }
    : null

export interface DisclosureScope { scope: 'kospi100' | 'kospi_all'; scopeAsOf: string | null }
export interface DisclosurePage { items: DisclosureItem[]; scope: DisclosureScope }
export function parseDisclosurePage(body: unknown): DisclosurePage | null {
  const record = asRecord(body)
  if (!record) return null
  return {
    items: listOf(record.data, disclosureItem),
    scope: { scope: record.scope === 'kospi100' ? 'kospi100' : 'kospi_all', scopeAsOf: isStr(record.scopeAsOf) ? record.scopeAsOf : null },
  }
}

export interface CapitalBucket {
  date: string
  dilution: number
  shareholderReturn: number
  treasuryDisposal: number
  dilutionCount: number
  shareholderReturnCount: number
  treasuryDisposalCount: number
  missingAmountCount: number
}
export interface CapitalEvents { bucket: 'day' | 'week'; buckets: CapitalBucket[]; top: DisclosureItem[]; since: string | null }
const BUCKET_NUMBERS = ['dilution', 'shareholderReturn', 'treasuryDisposal', 'dilutionCount', 'shareholderReturnCount', 'treasuryDisposalCount', 'missingAmountCount'] as const
export function parseCapitalEvents(body: unknown): CapitalEvents | null {
  const record = asRecord(body)
  if (!record) return null
  return {
    bucket: record.bucket === 'week' ? 'week' : 'day',
    buckets: listOf(record.buckets, item => (isStr(item.date) && BUCKET_NUMBERS.every(key => isNum(item[key])) ? (item as unknown as CapitalBucket) : null)),
    top: listOf(record.top, disclosureItem),
    since: isStr(record.since) ? record.since : null,
  }
}
