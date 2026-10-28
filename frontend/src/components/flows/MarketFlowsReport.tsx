import { useState } from 'react'
import { motion } from 'framer-motion'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/format'
import { useTokenColors } from '@/lib/theme'
import { changeRanking, compositionShares, FLOW_GROUPS, formatFlowChange, formatFlowValue, formatWon, latestWithChange, rangePosition, summaryLine, type FlowMetric } from '@/lib/marketFlows'
import { useMarketFlows } from '@/hooks/useMarketFlows'

// 증시 자금 흐름 탭 (docs/Task_ORDER.md 11단계 B′ T-98, D-65, D-77, D-78)
// 금융투자협회 종합통계(공공데이터포털)의 일별 통계를 최근 1개월만 보여 준다.
// 기본 화면(요약): ① 한 줄 요약 ② 1개월 범위 막대(지금 위치) ③ 한 달 변화 순위 ④ 구성 비율. "그래프로 보기"는 지표마다 작은 선 그래프(축 하나).
// 막대·점은 흑백(본문색), 등락 색은 증감에만 쓴다(D-32). 네온 강조색은 데이터에 쓰지 않는다(D-54).
// 지표 사이를 잇는 흐름도와 "과열·위험" 신호등은 넣지 않는다(측정된 이동이 없고 기준선 근거가 없음, D-46 · D-78).

const COLOR_TOKENS = ['surface', 'line'] as const
const cardClass = 'card-neon flex flex-col rounded-xl border border-line bg-surface p-4'
const changeColor = (change: number | null) => (change === null || change === 0 ? 'text-fg-muted' : change > 0 ? 'text-up' : 'text-down')

// 축 글자는 짧게: 금액은 조·억, 비중은 %
const axisTick = (value: number, unit: FlowMetric['unit']) => {
  if (unit === 'percent') return `${Math.round(value * 100) / 100}%`
  const abs = Math.abs(value)
  if (abs >= 1e12) return `${(value / 1e12).toFixed(1)}조`
  return `${Math.round(value / 1e8).toLocaleString('ko-KR')}억`
}

function MetricCard({ metric }: { metric: FlowMetric }) {
  const colors = useTokenColors(COLOR_TOKENS)
  const summary = latestWithChange(metric.points)

  return (
    <div className={cardClass}>
      <h4 className="text-[12px] font-medium text-fg-muted">{metric.label}</h4>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-lg font-semibold tabular-nums tracking-tight text-fg">{summary ? formatFlowValue(summary.latest.value, metric.unit) : '—'}</span>
        <span className={cn('text-[11px] font-medium tabular-nums', changeColor(summary?.change ?? null))}>
          {summary?.change !== null && summary ? formatFlowChange(summary.change, metric.unit) : ''}
        </span>
      </div>
      <div className="mb-2 h-4 text-[10px] tabular-nums text-fg-muted">
        {summary && `기준일 ${formatDate(summary.latest.time, true)}${summary.change !== null ? ' · 전 영업일 대비' : ''}`}
      </div>
      <div className="relative -mx-1 h-[110px] text-fg">
        {metric.points.length < 2 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center px-3 text-center text-[11px] text-fg-muted">
            {metric.points.length === 0 ? '데이터 준비 중' : '추이를 그리려면 이틀 이상 필요합니다'}
          </div>
        )}
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={metric.points} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" strokeOpacity={0.08} />
            <XAxis dataKey="time" axisLine={false} tickLine={false} minTickGap={28}
              tick={{ fill: 'currentColor', fillOpacity: 0.55, fontSize: 10 }}
              tickFormatter={(time: unknown) => (typeof time === 'number' ? formatDate(time) : '')} />
            <YAxis orientation="right" axisLine={false} tickLine={false} width={44} domain={['auto', 'auto']}
              tick={{ fill: 'currentColor', fillOpacity: 0.55, fontSize: 10 }}
              tickFormatter={(value: number) => axisTick(value, metric.unit)} />
            <Tooltip
              contentStyle={{ backgroundColor: colors.surface, border: `1px solid ${colors.line}`, borderRadius: 8, fontSize: 11, boxShadow: 'none' }}
              labelFormatter={(time: unknown) => (typeof time === 'number' ? formatDate(time, true) : '')}
              formatter={(value: unknown) => [typeof value === 'number' ? formatFlowValue(value, metric.unit) : '—', metric.label]}
              cursor={{ stroke: 'currentColor', strokeOpacity: 0.2 }}
            />
            <Line type="monotone" dataKey="value" stroke="currentColor" strokeWidth={1.5} dot={metric.points.length < 8} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

const SUMMARY_METRICS = ['capital.invrDpsgAmt', 'credit.crdTrFingWhl', 'capital.brkTrdUcolMny', 'capital.ucolMnyVsOppsTrdRlImpt']
const panelClass = 'card-neon rounded-xl border border-line bg-surface p-5'
const panelTitle = 'mb-3 flex flex-wrap items-baseline gap-2 text-[12px] font-semibold tracking-wide text-fg-muted'

// ① 한 줄 요약 (핵심 4개 지표)
function SummaryPanel({ byKey }: { byKey: Map<string, FlowMetric> }) {
  const lines = SUMMARY_METRICS.flatMap(key => {
    const metric = byKey.get(key)
    const line = metric ? summaryLine(metric) : null
    return line ? [line] : []
  })
  return (
    <section className={panelClass} aria-label="한 줄 요약">
      <h3 className={panelTitle}>한 줄 요약 <span className="text-[11px] font-normal">비교 기준은 최근 1개월</span></h3>
      <ul className="flex flex-col gap-2">
        {lines.map(line => (
          <li key={line.label} className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="text-fg-muted">{line.label}</span>
            <b className="font-semibold tabular-nums text-fg">{line.value}</b>
            <span className={cn('text-xs tabular-nums', changeColor(line.change))}>— {line.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ② 1개월 범위 막대: 최저 ~ 최고 사이에서 지금 값의 위치
function RangePanel({ byKey }: { byKey: Map<string, FlowMetric> }) {
  return (
    <section className={panelClass} aria-label="1개월 범위">
      <h3 className={panelTitle}>1개월 범위 <span className="text-[11px] font-normal">● 지금 값 · 왼쪽 최저 ~ 오른쪽 최고</span></h3>
      <div className="flex flex-col gap-4">
        {FLOW_GROUPS.map(group => (
          <div key={group.title} className="flex flex-col gap-2">
            <h4 className="text-[11px] font-medium text-fg-muted">{group.title}</h4>
            {group.metrics.map(key => {
              const metric = byKey.get(key)
              const range = metric ? rangePosition(metric.points) : null
              if (!metric || !range) return null
              return (
                <div key={key} className="grid grid-cols-[minmax(7rem,10rem)_1fr] items-center gap-3 text-[11px]">
                  <span className="truncate text-fg" title={metric.label}>{metric.label}</span>
                  <div className="flex flex-col gap-0.5">
                    <div className="relative h-1.5 w-full rounded-full bg-fg/10" aria-hidden>
                      {range.position !== null && (
                        <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-fg" style={{ left: `${range.position * 100}%` }} />
                      )}
                    </div>
                    <div className="flex justify-between gap-2 tabular-nums text-fg-muted">
                      <span>{formatFlowValue(range.min, metric.unit)}</span>
                      <span className="text-fg">{formatFlowValue(range.latest, metric.unit)} · {range.text}</span>
                      <span>{formatFlowValue(range.max, metric.unit)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </section>
  )
}

// ③ 한 달 변화 순위: 가운데 0, 오른쪽 증가 · 왼쪽 감소 (금액 지표, 변화율 기준)
function RankingPanel({ metrics }: { metrics: FlowMetric[] }) {
  const ranked = changeRanking(metrics)
  const scale = Math.max(...ranked.map(item => Math.abs(item.month.changePct)), 1)
  return (
    <section className={panelClass} aria-label="한 달 변화 순위">
      <h3 className={panelTitle}>한 달 변화 순위 <span className="text-[11px] font-normal">1개월 첫 값 대비, 금액 지표</span></h3>
      <div className="flex flex-col gap-1.5">
        {ranked.map(({ metric, month }) => {
          const width = (Math.abs(month.changePct) / scale) * 50
          return (
            <div key={metric.metric} className="grid grid-cols-[minmax(7rem,10rem)_1fr_4.5rem] items-center gap-3 text-[11px]">
              <span className="truncate text-fg" title={metric.label}>{metric.label}</span>
              <div className="relative h-2.5 w-full" aria-hidden>
                <span className="absolute inset-y-0 left-1/2 w-px bg-fg/30" />
                <span className={cn('absolute inset-y-0 rounded-sm', month.changePct >= 0 ? 'bg-up' : 'bg-down')}
                  style={month.changePct >= 0 ? { left: '50%', width: `${width}%` } : { right: '50%', width: `${width}%` }} />
              </div>
              <span className={cn('text-right tabular-nums', changeColor(month.changePct))}>
                {month.changePct > 0 ? '+' : month.changePct < 0 ? '−' : ''}{Math.abs(month.changePct).toFixed(1)}%
              </span>
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-[10px] text-fg-muted">반대매매비중(%)과 첫 값이 0인 지표는 변화율을 낼 수 없어 뺍니다.</p>
    </section>
  )
}

// ④ 구성 비율: 유가증권 · 코스닥
const COMPOSITIONS = [
  { title: '신용거래융자', total: 'credit.crdTrFingWhl', parts: [['유가증권', 'credit.crdTrFingScrs'], ['코스닥', 'credit.crdTrFingKosdaq']] },
  { title: '신용거래대주', total: 'credit.crdTrLndrWhl', parts: [['유가증권', 'credit.crdTrLndrScrs'], ['코스닥', 'credit.crdTrLndrKosdaq']] },
] as const

function CompositionPanel({ byKey }: { byKey: Map<string, FlowMetric> }) {
  return (
    <section className={panelClass} aria-label="구성 비율">
      <h3 className={panelTitle}>시장별 구성 <span className="text-[11px] font-normal">가장 최근 기준일</span></h3>
      <div className="flex flex-col gap-4">
        {COMPOSITIONS.map(item => {
          const lastValue = (key: string) => {
            const points = byKey.get(key)?.points ?? []
            return points[points.length - 1]?.value ?? null
          }
          const totalValue = lastValue(item.total)
          const result = compositionShares(item.parts.map(([label, key]) => ({ label, value: lastValue(key) ?? 0 })))
          if (!result) return null
          return (
            <div key={item.title} className="flex flex-col gap-1.5 text-[11px]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-fg">{item.title}</span>
                <span className="tabular-nums text-fg-muted">전체 {formatWon(totalValue ?? result.total)}</span>
              </div>
              <div className="flex h-3 w-full overflow-hidden rounded-full bg-fg/5" aria-hidden>
                {result.shares.map((part, index) => (
                  <span key={part.label} className={index === 0 ? 'bg-fg/70' : 'bg-fg/30'} style={{ width: `${part.share}%` }} />
                ))}
              </div>
              <div className="flex justify-between gap-2 tabular-nums text-fg-muted">
                {result.shares.map(part => <span key={part.label}>{part.label} {part.share.toFixed(0)}% · {formatWon(part.value)}</span>)}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function MarketFlowsReport() {
  const { data, status } = useMarketFlows()
  const [view, setView] = useState<'summary' | 'charts'>('summary')
  const byKey = new Map((data?.metrics ?? []).map(metric => [metric.metric, metric]))
  const hasData = (data?.metrics ?? []).some(metric => metric.points.length > 0)
  const message = status === 'loading' ? '불러오는 중' : status === 'error' ? '데이터를 불러오지 못했습니다' : !hasData ? '데이터 준비 중 (금융투자협회 일별 통계 수집 후 표시)' : null
  const deposit = byKey.get('capital.invrDpsgAmt')
  const latest = deposit ? latestWithChange(deposit.points) : null

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="flex w-full flex-col gap-8"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-xs leading-relaxed text-fg-muted">
          최근 1개월의 일별 통계입니다. 값은 영업일 기준 2 ~ 3일 늦게 공개되어, 가장 최근 기준일이 오늘보다 며칠 앞섭니다.
          {data?.latestTime ? <> 가장 최근 기준일 <b className="font-medium text-fg">{formatDate(data.latestTime, true)}</b>.</> : null}
          {latest && <> 투자자예탁금 {formatWon(latest.latest.value)}.</>}
        </p>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-line px-1.5 py-px text-[10px] font-medium leading-4 text-fg-muted">일별 · 1개월</span>
          <div className="flex gap-1" role="group" aria-label="보기 방식">
            {(['summary', 'charts'] as const).map(item => (
              <button key={item} type="button" aria-pressed={view === item} onClick={() => setView(item)}
                className={cn('rounded-md px-2 py-1 text-[11px] transition-colors duration-150',
                  view === item ? 'bg-fg font-medium text-page' : 'text-fg-muted hover:bg-fg/5 hover:text-fg')}>
                {item === 'summary' ? '요약' : '그래프로 보기'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {message ? (
        <div className="card-neon flex h-[240px] w-full items-center justify-center rounded-xl border border-dashed border-line bg-surface px-6 text-center text-xs text-fg-muted">{message}</div>
      ) : view === 'summary' ? (
        <>
          <SummaryPanel byKey={byKey} />
          <div className="grid w-full grid-cols-1 gap-5 xl:grid-cols-2">
            <RangePanel byKey={byKey} />
            <div className="flex flex-col gap-5">
              <RankingPanel metrics={data?.metrics ?? []} />
              <CompositionPanel byKey={byKey} />
            </div>
          </div>
        </>
      ) : (
        FLOW_GROUPS.map(group => (
          <section key={group.title} className="w-full" aria-label={group.title}>
            <h3 className="mb-3 flex flex-wrap items-baseline gap-2 text-[12px] font-semibold tracking-wide text-fg-muted">
              {group.title}
              <span className="text-[11px] font-normal">{group.note}</span>
            </h3>
            <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {group.metrics.map(key => {
                const metric = byKey.get(key)
                return metric ? <MetricCard key={key} metric={metric} /> : null
              })}
            </div>
          </section>
        ))
      )}

      <p className="text-[11px] leading-relaxed text-fg-muted">
        출처: 금융투자협회 종합통계(공공데이터포털 Open API). 항목 이름과 단위는 금융투자협회 통계 화면과 대조해 확인했습니다. 반대매매비중은 미수금 대비 비율(%)입니다.
      </p>
    </motion.div>
  )
}
