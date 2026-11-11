// 실적·배당 캘린더 표시 (docs/Task_ORDER.md T-111)
// 테스트할 수 있도록 React와 분리한 순수 함수다. 다른 모듈을 import하지 않는다.

export const CALENDAR_TYPES = ['earnings', 'dividend', 'report'] as const
export type CalendarType = (typeof CALENDAR_TYPES)[number]
export const CALENDAR_LABELS: Record<CalendarType, string> = { earnings: '잠정실적', dividend: '배당', report: '정기보고서' }

export interface CalendarDay {
  date: string
  earnings: number
  dividend: number
  report: number
  highlights: { corpName: string; type: CalendarType }[]
}

export interface CalendarItem { rceptNo: string; stockCode: string; corpName: string; reportName: string; type: CalendarType }

const isType = (value: unknown): value is CalendarType => typeof value === 'string' && (CALENDAR_TYPES as readonly string[]).includes(value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

export function toCalendarDays(raw: unknown): CalendarDay[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const { date, earnings, dividend, report, highlights } = item as Record<string, unknown>
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isCount(earnings) || !isCount(dividend) || !isCount(report)) return []
    const list = Array.isArray(highlights)
      ? highlights.flatMap(entry => {
        const { corpName, type } = (entry ?? {}) as Record<string, unknown>
        return typeof corpName === 'string' && isType(type) ? [{ corpName, type }] : []
      })
      : []
    return [{ date, earnings, dividend, report, highlights: list }]
  })
}

export function toCalendarItems(raw: unknown): CalendarItem[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const { rceptNo, stockCode, corpName, reportName, type } = item as Record<string, unknown>
    if (typeof rceptNo !== 'string' || typeof corpName !== 'string' || typeof reportName !== 'string' || !isType(type)) return []
    return [{ rceptNo, stockCode: typeof stockCode === 'string' ? stockCode : '', corpName, reportName, type }]
  })
}

const pad = (value: number) => String(value).padStart(2, '0')

// "2026-10" ± n개월
export function shiftMonth(month: string, delta: number) {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`
}

export const monthOf = (date: string) => date.slice(0, 7)

// 달력 칸: 월요일부터 시작하는 주 단위. 그 달이 아닌 칸은 null
export function monthGrid(month: string): (string | null)[][] {
  const year = Number(month.slice(0, 4))
  const mon = Number(month.slice(5, 7))
  const first = new Date(Date.UTC(year, mon - 1, 1))
  const days = new Date(Date.UTC(year, mon, 0)).getUTCDate()
  const offset = (first.getUTCDay() + 6) % 7 // 월요일 = 0
  const cells: (string | null)[] = []
  for (let index = 0; index < offset; index += 1) cells.push(null)
  for (let day = 1; day <= days; day += 1) cells.push(`${month}-${pad(day)}`)
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: (string | null)[][] = []
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7))
  return weeks
}
