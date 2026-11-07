import { toCalendarDays, toCalendarItems, type CalendarDay, type CalendarItem } from '@/lib/calendar'
import { toRankingItems, type RankingItem } from '@/lib/rankings'
import { toPipelineStatus } from '@/lib/pipeline'
import { STALE_MS } from '@/lib/queryClient'
import { toResult, useApiQuery } from '@/hooks/useApiQuery'

// 15단계 분석 카테고리 데이터 (docs/Task_ORDER.md T-111 ~ T-113). 조회는 공통 훅(useApiQuery, T-165)을 거친다
// - 실적·배당 캘린더: `/api/v1/disclosures/calendar?month=` · `?date=`
// - 종목 순위: `/api/v1/market/rankings?market=&type=&date=`
// - 파이프라인 상태: `/api/v1/system/pipeline` (설정 창이 열려 있을 때만 30초마다)

const asObject = (body: unknown) => (body && typeof body === 'object' ? (body as Record<string, unknown>) : null)
const coverageOf = (value: unknown) => {
  const record = asObject(value)
  return record && typeof record.since === 'string' && typeof record.until === 'string' ? { since: record.since, until: record.until } : null
}

export interface CalendarMonth { month: string; days: CalendarDay[]; coverage: { since: string; until: string } | null }
const parseMonth = (body: unknown): CalendarMonth | null => {
  const record = asObject(body)
  return record && typeof record.month === 'string' ? { month: record.month, days: toCalendarDays(record.days), coverage: coverageOf(record.coverage) } : null
}
export const useDisclosureCalendar = (month: string) =>
  toResult(useApiQuery(['calendar', 'month', month], 'disclosures/calendar', { month }, parseMonth, { staleTime: STALE_MS.daily }))

export interface CalendarDayList { date: string; items: CalendarItem[]; limit: number }
const parseDay = (body: unknown): CalendarDayList | null => {
  const record = asObject(body)
  return record && typeof record.date === 'string'
    ? { date: record.date, items: toCalendarItems(record.items), limit: typeof record.limit === 'number' ? record.limit : 0 }
    : null
}
export const useCalendarDay = (date: string | null) =>
  toResult(useApiQuery(['calendar', 'day', date], 'disclosures/calendar', { date }, parseDay, { enabled: date !== null, staleTime: STALE_MS.daily }))

export interface Rankings { date: string | null; items: RankingItem[]; coverage: Record<string, { since: string; until: string } | null> }
const parseRankings = (body: unknown): Rankings | null => {
  const record = asObject(body)
  if (!record) return null
  const coverage = asObject(record.coverage) ?? {}
  return {
    date: typeof record.date === 'string' ? record.date : null,
    items: toRankingItems(record.items),
    coverage: Object.fromEntries(Object.entries(coverage).map(([market, value]) => [market, coverageOf(value)])),
  }
}
export const useRankings = (market: string, type: string, date: string | null) =>
  toResult(useApiQuery(['rankings', market, type, date], 'market/rankings', { market, type, date }, parseRankings, { staleTime: STALE_MS.daily }))

// 파이프라인 상태: 형식 검사(toPipelineStatus)를 거친 값만 쓴다. 설정 창이 닫혀 있으면 요청하지 않는다
export const usePipelineStatus = (enabled: boolean) =>
  toResult(useApiQuery(['pipeline'], 'system/pipeline', {}, toPipelineStatus, { enabled, staleTime: 15_000, refetchInterval: enabled ? 30_000 : false }))
