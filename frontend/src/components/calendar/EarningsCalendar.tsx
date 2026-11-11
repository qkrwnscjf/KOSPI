import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CALENDAR_LABELS, CALENDAR_TYPES, dayKind, holidayName, monthGrid, monthOf, shiftMonth, type CalendarType, type DayKind } from '@/lib/calendar'
import { dartViewerUrl, seoulToday } from '@/lib/disclosures'
import { useCalendarDay, useDisclosureCalendar } from '@/hooks/useAnalytics'

// 실적·배당 캘린더 탭 (docs/Task_ORDER.md 15단계 T-111, D-72)
// 이미 저장된 DART 공시(유가증권)에서 잠정실적·배당 결정·정기보고서를 날짜별로 보여 준다. 정정 공시는 빼고 원 공시만 센다.
// 앞으로의 일정(발표 예정일)은 공시 본문에 있어서 보여 주지 않는다. 종류는 점 모양과 글자로 구분한다(색만으로 구분하지 않음).

const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일']
const cardClass = 'card-neon rounded-xl border border-line bg-surface'
// 종류별 표시: 데이터 색은 흑백 농도로만(네온 강조색은 데이터에 쓰지 않음, D-54)
const TYPE_STYLE: Record<CalendarType, string> = {
  earnings: 'bg-fg',
  dividend: 'border border-fg bg-transparent',
  report: 'bg-fg/30',
}

// 일요일·공휴일은 빨강, 토요일은 파랑 (T-167). 공휴일은 이름을 함께 적어 색만으로 구분하지 않는다
const DAY_TEXT: Record<DayKind, string> = { holiday: 'text-holiday', sunday: 'text-holiday', saturday: 'text-saturday', weekday: '' }
const DAY_TINT: Record<DayKind, string> = { holiday: 'bg-holiday/[0.05]', sunday: 'bg-holiday/[0.05]', saturday: 'bg-saturday/[0.05]', weekday: '' }
const WEEKDAY_TEXT: Record<string, string> = { 토: 'text-saturday', 일: 'text-holiday' }

function TypeDot({ type }: { type: CalendarType }) {
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', TYPE_STYLE[type])} aria-hidden />
}

function DayDetail({ date, filter }: { date: string; filter: Set<CalendarType> }) {
  const { data, status } = useCalendarDay(date)
  const items = (data?.items ?? []).filter(item => filter.has(item.type))
  const holiday = holidayName(date)
  return (
    <div className={cn(cardClass, 'flex flex-col p-5')}>
      <h3 className="mb-3 text-[13px] font-medium text-fg-muted">
        <span className={DAY_TEXT[dayKind(date)]}>{date}{holiday && ` · ${holiday}`}</span> 공시 <span className="text-[11px]">({items.length}건)</span>
      </h3>
      {status === 'loading' && <p className="py-6 text-center text-xs text-fg-muted">불러오는 중</p>}
      {status === 'error' && <p className="py-6 text-center text-xs text-fg-muted">데이터를 불러오지 못했습니다</p>}
      {status === 'loaded' && items.length === 0 && <p className="py-6 text-center text-xs text-fg-muted">이 날의 공시가 없습니다</p>}
      <ul className="max-h-[520px] overflow-y-auto">
        {items.map(item => {
          const href = dartViewerUrl(item.rceptNo)
          return (
            <li key={item.rceptNo} className="border-b border-line last:border-b-0">
              <a href={href ?? undefined} target="_blank" rel="noopener noreferrer"
                className="group flex items-start gap-2.5 rounded-md py-2.5 outline-none focus-visible:ring-1 focus-visible:ring-neon">
                <span className="mt-1.5"><TypeDot type={item.type} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                    <span>{CALENDAR_LABELS[item.type]}</span>
                    {item.stockCode && <span className="tabular-nums">{item.stockCode}</span>}
                  </div>
                  <p className="text-[13px] leading-snug text-fg group-hover:underline">
                    <b className="font-semibold">{item.corpName}</b> · {item.reportName}
                  </p>
                </div>
                {href && <ExternalLink className="mt-1 h-3 w-3 shrink-0 text-fg-muted group-hover:text-fg" aria-hidden />}
              </a>
            </li>
          )
        })}
      </ul>
      {data && data.items.length >= data.limit && data.limit > 0 && (
        <p className="mt-2 text-[11px] text-fg-muted">하루 최대 {data.limit}건까지만 보여 줍니다.</p>
      )}
    </div>
  )
}

export function EarningsCalendar() {
  const today = seoulToday()
  const [month, setMonth] = useState(monthOf(today))
  const [selected, setSelected] = useState<string | null>(today)
  const [filter, setFilter] = useState<Set<CalendarType>>(new Set(CALENDAR_TYPES))
  const { data, status } = useDisclosureCalendar(month)
  const byDate = useMemo(() => new Map((data?.days ?? []).map(day => [day.date, day])), [data])
  const weeks = monthGrid(month)
  const since = data?.coverage?.since ?? null
  const canPrev = since === null || shiftMonth(month, -1) >= monthOf(since)
  const canNext = month < monthOf(today)

  const toggle = (type: CalendarType) => setFilter(previous => {
    const next = new Set(previous)
    if (next.has(type) && next.size > 1) next.delete(type)
    else next.add(type)
    return next
  })

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="flex w-full flex-col gap-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" aria-label="이전 달" disabled={!canPrev} onClick={() => setMonth(shiftMonth(month, -1))}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-fg transition-colors hover:border-neon/50 disabled:opacity-30">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[96px] text-center text-sm font-semibold tabular-nums text-fg">{month.replace('-', '년 ')}월</span>
          <button type="button" aria-label="다음 달" disabled={!canNext} onClick={() => setMonth(shiftMonth(month, 1))}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-fg transition-colors hover:border-neon/50 disabled:opacity-30">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex gap-1" role="group" aria-label="공시 종류 선택">
          {CALENDAR_TYPES.map(type => (
            <button key={type} type="button" aria-pressed={filter.has(type)} onClick={() => toggle(type)}
              className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors duration-150',
                filter.has(type) ? 'bg-fg/10 font-medium text-fg' : 'text-fg-muted hover:bg-fg/5')}>
              <TypeDot type={type} /> {CALENDAR_LABELS[type]}
            </button>
          ))}
        </div>
      </div>

      <div className="grid w-full grid-cols-1 gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className={cn(cardClass, 'overflow-x-auto p-3 md:p-4')}>
          <div className="grid min-w-[560px] grid-cols-7 gap-1">
            {WEEKDAYS.map(day => <div key={day} className={cn('pb-1 text-center text-[11px] font-medium text-fg-muted', WEEKDAY_TEXT[day])}>{day}</div>)}
            {weeks.flat().map((date, index) => {
              if (date === null) return <div key={`empty-${index}`} className="min-h-[92px]" />
              const day = byDate.get(date)
              const counts = CALENDAR_TYPES.filter(type => filter.has(type)).map(type => [type, day?.[type] ?? 0] as const).filter(([, count]) => count > 0)
              const highlights = (day?.highlights ?? []).filter(item => filter.has(item.type)).slice(0, 3)
              const isSelected = selected === date
              const kind = dayKind(date)
              const holiday = holidayName(date)
              return (
                <button key={date} type="button" onClick={() => setSelected(date)} aria-pressed={isSelected}
                  className={cn('flex min-h-[92px] flex-col gap-1 rounded-lg border p-1.5 text-left transition-colors duration-150',
                    isSelected ? 'border-neon/60 bg-neon/5' : cn('border-line hover:border-line-strong', DAY_TINT[kind]),
                    date === today && 'ring-1 ring-inset ring-fg/30')}>
                  <span className="flex items-baseline gap-1">
                    <span className={cn('text-[11px] tabular-nums', date === today ? 'font-semibold text-fg' : 'text-fg-muted', DAY_TEXT[kind], kind !== 'weekday' && 'font-medium')}>
                      {Number(date.slice(8))}
                    </span>
                    {holiday && <span className="truncate text-[10px] leading-3 text-holiday">{holiday}</span>}
                  </span>
                  {counts.map(([type, count]) => (
                    <span key={type} className="flex items-center gap-1 text-[10px] leading-3 text-fg">
                      <TypeDot type={type} /> {CALENDAR_LABELS[type]} {count}
                    </span>
                  ))}
                  {highlights.map(item => (
                    <span key={`${item.type}-${item.corpName}`} className="truncate text-[10px] leading-3 text-fg-muted">{item.corpName}</span>
                  ))}
                </button>
              )
            })}
          </div>
          {status === 'error' && <p className="pt-3 text-center text-xs text-fg-muted">데이터를 불러오지 못했습니다</p>}
        </div>
        {selected && <DayDetail date={selected} filter={filter} />}
      </div>

      <p className="text-[11px] leading-relaxed text-fg-muted">
        출처: 금융감독원 DART(유가증권시장). 이미 접수된 공시만 보여 주며, 앞으로의 발표 예정일은 다루지 않습니다.
        {since && ` 수집 시작 ${since}.`} 정정 공시는 빼고 원 공시만 셉니다. 날짜 색: <span className="text-holiday">일요일·공휴일</span>, <span className="text-saturday">토요일</span>.
      </p>
    </motion.div>
  )
}
