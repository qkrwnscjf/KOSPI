import { useState, useSyncExternalStore } from 'react'
import { AreaChart, Area, ResponsiveContainer, YAxis, Tooltip, XAxis, CartesianGrid } from 'recharts'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatAxisNumber, formatClock, formatDate, formatNumber } from '@/lib/format'
import { isKrxExtendedHour, isMarketOpen, marketBadge, type MarketId } from '@/lib/marketHours'
import { useMarketData, useSpreadTick, type ChartStatus } from '@/hooks/useMarketData'
import { periodDirection, type Direction } from '@/lib/chartPoints'
import { combineLags, delayBadgeMinutes, type SourceLag } from '@/lib/sourceLag'
import { dataStatus, STALE_AFTER_MS } from '@/lib/dataStatus'
import { useSourceLags } from '@/hooks/useSourceLags'
import type { TickData } from '@/lib/marketSocket'
import type { ChartCardConfig } from '@/constants/data'
import { createClock } from '@/lib/sharedSource'
import { SegmentedControl, segmentsOf } from '@/components/common/SegmentedControl'
import { chartSummary } from '@/lib/chartSummary'

const TIME_RANGES = ['실시간', '1일', '1주', '1개월', '3개월', '1년']
// 일별 시세 지표(T-67)는 하루 1개 값이라 실시간·1일 그래프가 없다
const DAILY_RANGES = ['1주', '1개월', '3개월', '1년']
// 계산 카드(T-107)는 서버가 집계끼리 계산하므로 실시간 그래프가 없다
const SPREAD_RANGES = ['1일', '1주', '1개월', '3개월', '1년']

// 차트 영역에 데이터 대신 보여 줄 안내 문구. 데이터가 있으면 null.
function chartMessage(status: ChartStatus, points: number, isRealtime: boolean) {
  if (status === 'not_ready') return '데이터 준비 중' // T-26, R-04
  if (status === 'error') return '데이터를 불러오지 못했습니다'
  if (points > 0) return null
  if (status === 'loading') return '불러오는 중'
  return isRealtime ? '실시간 데이터 수신 대기 중' : '표시할 데이터가 없습니다'
}

// X축 눈금 (타임프레임별)
function formatXAxis(time: number, range: string) {
  if (range === '실시간') return formatClock(time)
  if (range === '1일') return formatClock(time, false)
  if (range === '1년') return formatDate(time, true).slice(2)
  return formatDate(time)
}

// 툴팁에는 날짜와 시각을 함께 보여 준다 (T-35)
function formatTooltipTime(time: number, range: string) {
  if (range === '실시간') return `${formatDate(time)} ${formatClock(time)}`
  if (range === '1일' || range === '1주') return `${formatDate(time)} ${formatClock(time, false)}`
  return formatDate(time, true)
}

// 앱 전체가 함께 쓰는 1초 시계 (plan.md FQA-02, T-193). 예전에는 카드마다 타이머가 따로 돌았다(섹터 탭 17개)
const secondClock = createClock(1000)
const useNow = () => useSyncExternalStore(secondClock.subscribe, secondClock.getSnapshot)

const dateTime = (ms: number) => new Date(ms).toLocaleString('ko-KR')

interface PriceAndStatusProps {
  ready: boolean
  latest: TickData | null
  decimals: number
  prefix?: string | undefined
  suffix?: string | undefined
  market?: MarketId | undefined
  daily?: boolean | undefined
  lag: SourceLag | undefined
}

// 현재가와 데이터 상태 한 줄 (T-168, B-70). 1초마다 바뀌는 이 부분만 따로 그린다 (T-34: 차트는 다시 그리지 않음).
// 한 줄: ● 장 상태(T-42, 공휴일은 소스 장 상태 T-56) · 소스 지연(T-162 실측) · 마지막 수신(worker 수집 시각).
// 장이 열려 있는데 오래 새 값이 없으면 "갱신 지연"을 붙이고 가격을 흐리게 한다
function PriceAndStatus({ ready, latest, decimals, prefix, suffix, market, daily, lag }: PriceAndStatusProps) {
  const now = useNow()
  const delayMinutes = daily ? null : delayBadgeMinutes(lag)
  // 특수 거래일의 늘어난 시간에는 소스 PRE·POST를 장중으로 본다 (QA-44 / P4-3, T-180)
  const badge = ready && market && !daily
    ? marketBadge(isMarketOpen(market, new Date(now)), latest?.marketState, market === 'krx' && isKrxExtendedHour(new Date(now)))
    : null
  const status = ready && !daily
    ? dataStatus({ marketLabel: badge?.label ?? null, marketOpen: badge?.open ?? false, delayMinutes, sourceTime: latest?.timestamp ?? null, receivedAt: latest?.collectedAt ?? null, now })
    : null
  const details = [
    delayMinutes !== null && lag ? `소스가 약 ${delayMinutes}분 늦은 시세를 제공합니다 (장중 실측, ${formatDate(lag.measuredAt)} ${formatClock(lag.measuredAt, false)} 기준)` : null,
    latest && !daily ? `소스 시각 ${dateTime(latest.timestamp)}` : null,
    latest?.collectedAt !== undefined && !daily ? `수신 ${dateTime(latest.collectedAt)}` : null,
    status?.stale ? `장중인데 ${STALE_AFTER_MS / 60_000}분 넘게 새 값을 받지 못했습니다` : null,
    daily ? 'KRX Open API 일별 시세입니다. 장 마감 후 하루 1번 갱신됩니다' : null,
  ].filter(Boolean).join('\n')

  return (
    <>
      <div className={cn('flex items-baseline gap-1 text-2xl font-semibold tracking-tight text-fg tabular-nums transition-opacity', status?.stale && 'opacity-50')}>
        {latest ? (
          <>
            {prefix && <span className="text-base font-medium text-fg-muted">{prefix}</span>}
            {formatNumber(latest.price, decimals)}
            {suffix && <span className="text-xs font-medium text-fg-muted">{suffix}</span>}
          </>
        ) : (
          <span className="text-fg-muted">—</span>
        )}
      </div>
      {/* 상태 한 줄을 하나의 블록(둥근 테두리)으로 감싼다. 갱신 지연이면 테두리·글자를 진하게 */}
      <div className="mt-1 flex h-5 items-center">
        {((ready && daily) || (status && status.parts.length > 0)) && (
          <span
            className={cn('inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2 py-px text-[11px] leading-4 tabular-nums',
              status?.stale ? 'border-fg/50 font-medium text-fg' : badge?.open ? 'border-fg/25 text-fg-muted' : 'border-line text-fg-muted')}
            title={details || undefined}
          >
            {badge && <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', badge.open ? 'bg-fg' : 'bg-fg-muted/50')} aria-hidden />}
            <span className="truncate">
              {ready && daily ? `일별 시세${latest ? ` · 기준일 ${formatDate(latest.timestamp, true)}` : ''}` : status?.parts.join(' · ')}
            </span>
          </span>
        )}
      </div>
    </>
  )
}

// 등락 색은 미국식(상승 초록, 하락 빨강, D-32). 등락 0은 중립 (T-43)
const DIRECTION_STYLE: Record<Direction, string> = {
  up: 'text-up bg-up/10',
  down: 'text-down bg-down/10',
  flat: 'text-fg-muted bg-fg/5',
}
const DIRECTION_ICON = { up: TrendingUp, down: TrendingDown, flat: Minus }

// 그래프 선·채우기 색 (D-37): 상승 초록, 하락 빨강, 변화 없음은 본문색. 기간 방향은 lib/chartPoints.ts
const CHART_COLOR: Record<Direction, string> = { up: 'text-up', down: 'text-down', flat: 'text-fg' }

export function ChartCard({ title, symbol, ready, decimals, prefix, suffix, market, daily, spread }: ChartCardConfig) {
  const ranges = daily ? DAILY_RANGES : spread ? SPREAD_RANGES : TIME_RANGES
  const [activeRange, setActiveRange] = useState(daily ? '1개월' : spread ? '1일' : '실시간')
  const { latest: ownLatest, chartData, status } = useMarketData(symbol, activeRange, ready, !spread)
  // 계산 카드는 두 지표의 최신 tick으로 현재값을 계산한다 (T-107)
  const spreadLatest = useSpreadTick(symbol, spread, ready)
  const latest = spread ? spreadLatest : ownLatest

  // 등락 방향: 계산 카드는 전일 대비 변화량(%p), 나머지는 등락률(%)
  const change = spread ? latest?.changePrice : latest?.changeRate
  const direction: Direction | null = latest && change !== undefined ? (change > 0 ? 'up' : change < 0 ? 'down' : 'flat') : null
  const DirectionIcon = direction ? DIRECTION_ICON[direction] : null
  const message = chartMessage(status, chartData.length, activeRange === '실시간')
  // SVG id에는 공백·괄호가 들어가면 안 되므로 심볼로 만든다 (T-35: 이전에는 제목을 써서 일부 카드에서 채우기가 적용되지 않았음)
  const gradientId = `chart-fill-${symbol.replace(/[^A-Za-z0-9_-]/g, '_')}`
  // 실시간은 등락 배지와 같은 기준(전일 대비)을 써서, 짧은 구간의 흔들림으로 색이 계속 바뀌지 않게 한다.
  // 1일 ~ 1년은 그래프에 보이는 기간의 등락을 따른다.
  const chartDirection = activeRange === '실시간' ? direction : periodDirection(chartData)
  const chartColor = chartDirection ? CHART_COLOR[chartDirection] : 'text-fg'
  // 소스 지연 (T-162): 고정값 대신 backend가 장중에 측정한 값. 계산 카드는 두 지표 중 늦은 쪽, 일별 지표는 해당 없음
  const sourceLags = useSourceLags()
  const lag = daily ? undefined : spread ? combineLags(sourceLags[spread.long], sourceLags[spread.short]) : sourceLags[symbol]

  return (
    // 등장 효과는 DashboardGrid의 감싸는 요소가 맡는다 (plan.md FQA-04, T-195: 예전에는 카드 안에서 한 번 더 움직였다)
    // 마우스를 올리면 테두리가 강조색으로 은은하게 빛난다 (T-69). 그래프 색은 등락 색 그대로다
    <div className="card-neon relative h-[340px] rounded-xl border border-line bg-surface">
      <div className="flex h-full flex-col p-5">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="mb-1 text-[13px] font-medium text-fg-muted">{title}</h3>
            <PriceAndStatus ready={ready} latest={latest} decimals={decimals} prefix={prefix} suffix={suffix} market={market} daily={daily} lag={lag} />
          </div>
          {latest && change !== undefined && direction && DirectionIcon && (
            <div className={cn('flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold tabular-nums', DIRECTION_STYLE[direction])}>
              <DirectionIcon className="h-3 w-3" aria-hidden />
              {/* 등락률은 모든 지표에서 % 단위다 (T-27, P-19). 계산 카드는 변화량(%p) */}
              {change > 0 ? '+' : ''}{change.toFixed(spread ? 3 : 2)}{spread ? '%p' : '%'}
            </div>
          )}
        </div>

        {/* Time Range Selector: 선택된 항목은 흑백 반전 (D-35) */}
        <SegmentedControl className="mb-3" label={`${title} 기간 선택`} options={segmentsOf(ranges)} value={activeRange} onChange={setActiveRange} />

        {/* 격자·축·커서는 currentColor(본문색), 선·채우기는 등락 색 클래스를 따로 받는다. 모두 라이트·다크에 맞게 바뀐다 */}
        {/* 그래프의 글 대안 (plan.md FQA-11, T-197): 화면 읽기 프로그램은 그림 대신 시작·마지막 값과 기간 등락을 읽는다 */}
        <div className="relative -mx-2 flex-1 text-fg" role="img" aria-label={chartSummary(title, activeRange, chartData, value => `${prefix ?? ''}${formatNumber(value, decimals)}${suffix ? ` ${suffix}` : ''}`)}>
          {message && (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-fg-muted">
              {message}
            </div>
          )}
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" className={chartColor} stopColor="currentColor" stopOpacity={0.18} />
                  <stop offset="100%" className={chartColor} stopColor="currentColor" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" strokeOpacity={0.08} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'rgb(var(--color-surface))',
                  border: '1px solid rgb(var(--color-line))',
                  borderRadius: '8px',
                  fontSize: '11px',
                  boxShadow: 'none',
                }}
                itemStyle={{ color: 'rgb(var(--color-fg))', padding: '2px 0' }}
                labelStyle={{ color: 'rgb(var(--color-fg-muted))', marginBottom: '2px' }}
                labelFormatter={(label: unknown) => (typeof label === 'number' ? formatTooltipTime(label, activeRange) : '')}
                cursor={{ stroke: 'currentColor', strokeOpacity: 0.25, strokeWidth: 1 }}
                formatter={(value: unknown) => [`${prefix ?? ''}${formatNumber(Number(value), decimals)}${suffix ? ` ${suffix}` : ''}`, title]}
              />
              <XAxis
                dataKey="time"
                axisLine={false}
                tickLine={false}
                tick={{ fill: 'currentColor', fillOpacity: 0.55, fontSize: 10 }}
                minTickGap={30}
                tickFormatter={(time: unknown) => (typeof time === 'number' ? formatXAxis(time, activeRange) : String(time))}
              />
              <YAxis
                orientation="right"
                tick={{ fill: 'currentColor', fillOpacity: 0.55, fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(value: number) => formatAxisNumber(value, decimals)}
                domain={['auto', 'auto']}
                width={60}
              />
              <Area
                type="monotone"
                dataKey="value"
                className={chartColor}
                stroke="currentColor"
                strokeWidth={1.5}
                fill={`url(#${gradientId})`}
                /* 실시간은 tick마다 점이 붙어 300ms 선 애니메이션이 매번 처음부터 다시 돌았다 → 끈다 (plan.md FQA-03, T-194).
                   1일 ~ 1년은 기간을 바꿀 때만 그려서 그대로 둔다(1초 애니메이션 동안 새 값이 늦게 그려져 300ms로 줄임, T-27) */
                isAnimationActive={activeRange !== '실시간'}
                animationDuration={300}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}
