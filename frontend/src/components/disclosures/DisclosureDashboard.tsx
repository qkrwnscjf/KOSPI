import { useState } from 'react'
import { motion } from 'framer-motion'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTokenColors } from '@/lib/theme'
import { dartViewerUrl, formatKrw, GROUPS, groupLabel, kindLabel, seoulToday, toEokWon, type DisclosureItem } from '@/lib/disclosures'
import { useCapitalEvents, useRecentDisclosures, type CapitalBucket, type DisclosureScope } from '@/hooks/useDisclosures'
import type { ChartStatus } from '@/hooks/useMarketData'
import { SegmentedControl } from '@/components/common/SegmentedControl'
import { StatusMessage } from '@/components/common/StatusMessage'
import { CARD_FRAME, isLoadingText, segmentsOf, statusText } from '@/lib/ui'

// 공시·자본 이벤트 탭 (docs/Task_ORDER.md 12단계 T-78, D-59)
// ① 공시 속보: 최근 공시 목록(새 공시는 실시간으로 위에 추가)
// ② 자본 이벤트 지표: 기간별 희석(유상증자·사채) vs 주주환원(자사주 취득·소각) vs 자사주 처분 금액
// 색은 흑백 토큰 + 등락 색 규칙(희석은 하락색, 주주환원은 상승색, 처분은 보조색). 네온 강조색은 데이터에 쓰지 않는다 (D-54).
// 계열마다 범례·툴팁에 이름을 함께 적어서 색만으로 구분하지 않는다.

const RANGES = ['1주', '1개월', '3개월', '1년']
const COLOR_TOKENS = ['up', 'down', 'fg-muted', 'surface', 'line'] as const
// 카드 틀·상태 문구는 공통(lib/ui.ts, plan.md FQA-08, T-221)
const cardClass = cn(CARD_FRAME, 'p-5')
const badgeClass = 'inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10px] font-medium leading-4'
const CAPITAL_GROUPS = new Set(['dilution', 'shareholder_return', 'treasury_disposal'])

const SERIES = [
  { key: 'dilution', label: '희석 (유상증자·사채)', token: 'down' },
  { key: 'shareholderReturn', label: '주주환원 (자사주 취득·소각)', token: 'up' },
  { key: 'treasuryDisposal', label: '자사주 처분', token: 'fg-muted' },
] as const

const groupBadgeClass = (group: string) =>
  group === 'dilution' ? 'border-down/40 text-down' : group === 'shareholder_return' ? 'border-up/40 text-up' : 'border-line text-fg-muted'

const statusMessage = (status: ChartStatus, empty: boolean, emptyText: string) => statusText(status, empty, emptyText)

function ScopeNote({ scope }: { scope: DisclosureScope | null }) {
  if (!scope) return null
  return (
    <p className="text-[11px] text-fg-muted">
      대상: {scope.scope === 'kospi100'
        ? `KOSPI 100 구성 종목${scope.scopeAsOf ? ` (기준일 ${scope.scopeAsOf})` : ''}`
        : '유가증권시장 상장사 전체 (KOSPI 100 명단을 넣으면 그 종목만 보여 줍니다)'}
      {' · '}자료: 금융감독원 DART OpenAPI
    </p>
  )
}

function StatTile({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="text-[11px] font-medium text-fg-muted">{label}</div>
      <div className={cn('mt-1 text-xl font-semibold tabular-nums tracking-tight', tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-fg')}>{value}</div>
    </div>
  )
}

function DisclosureRow({ item }: { item: DisclosureItem }) {
  const url = dartViewerUrl(item.rceptNo)
  const kind = kindLabel(item.kind)
  return (
    <li className="flex items-start gap-3 border-b border-line py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn(badgeClass, groupBadgeClass(item.group))}>{kind ?? groupLabel(item.group)}</span>
          {item.isCorrection && <span className={cn(badgeClass, 'border-line text-fg-muted')}>정정</span>}
          <span className="truncate text-[13px] font-medium text-fg">{item.corpName}</span>
          <span className="text-[11px] text-fg-muted tabular-nums">{item.stockCode}</span>
        </div>
        <div className="mt-0.5 truncate text-xs text-fg-muted" title={item.reportName}>{item.reportName}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
        {CAPITAL_GROUPS.has(item.group) && (
          <span className={cn('text-xs font-semibold tabular-nums', item.amount === null ? 'text-fg-muted' : 'text-fg')}>{formatKrw(item.amount)}</span>
        )}
        <span className="flex items-center gap-1 text-[11px] text-fg-muted tabular-nums">
          {item.rceptDate.slice(5).replace('-', '/')}
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`${item.corpName} 공시 원문 (DART, 새 창)`} className="text-fg-muted hover:text-neon">
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </span>
      </div>
    </li>
  )
}

function DisclosureFeed({ group, setGroup }: { group: string; setGroup: (group: string) => void }) {
  const { items, status, scope } = useRecentDisclosures(group)
  const message = statusMessage(status, items.length === 0, '최근 30일 동안 이 분류의 공시가 없습니다')
  return (
    <div className={cn(cardClass, 'flex flex-col')}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-medium text-fg-muted">공시 속보 <span className="text-[11px]">(최근 100건, 새 공시는 자동 추가)</span></h3>
      </div>
      <SegmentedControl className="mb-2" scroll label="공시 분류" options={GROUPS} value={group} onChange={setGroup} />
      <div className="relative min-h-[200px] flex-1">
        {/* 불러오는 동안은 목록 최대 높이(520px)를 미리 잡아, 목록이 오면서 오른쪽 카드·아래 내용이 밀리지 않게 한다 (plan.md FQA-16, T-222) */}
        {message ? (
          <StatusMessage message={message} className={isLoadingText(message) ? 'h-[520px] justify-start py-4' : 'h-[200px]'} />
        ) : (
          <ul className="max-h-[520px] overflow-y-auto pr-1">
            {items.map(item => <DisclosureRow key={item.rceptNo} item={item} />)}
          </ul>
        )}
      </div>
      <div className="mt-3"><ScopeNote scope={scope} /></div>
    </div>
  )
}

const formatBucketDate = (date: string) => date.slice(5).replace('-', '/')

function CapitalEventsCard({ range, setRange, buckets, top, since, status, weekly }: {
  range: string
  setRange: (range: string) => void
  buckets: CapitalBucket[]
  top: DisclosureItem[]
  since: string | null
  status: ChartStatus
  weekly: boolean
}) {
  const colors = useTokenColors(COLOR_TOKENS)
  const data = buckets.map(bucket => ({
    date: bucket.date,
    dilution: toEokWon(bucket.dilution),
    shareholderReturn: toEokWon(bucket.shareholderReturn),
    treasuryDisposal: toEokWon(bucket.treasuryDisposal),
    counts: bucket,
  }))
  const message = statusMessage(status, data.length === 0, '이 기간에 자본 이벤트 공시가 없습니다')

  return (
    <div className={cn(cardClass, 'flex flex-col')}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-medium text-fg-muted">
          자본 이벤트 금액 <span className="text-[11px]">(억원, {weekly ? '주별' : '일별'} 합계 · 정정은 최종본 기준으로 한 번)</span>
        </h3>
      </div>
      <SegmentedControl className="mb-2" label="자본 이벤트 기간 선택" options={segmentsOf(RANGES)} value={range} onChange={setRange} />
      {/* 범례: 색과 이름을 함께 */}
      <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-fg-muted">
        {SERIES.map(series => (
          <span key={series.key} className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: colors[series.token] }} aria-hidden />
            {series.label}
          </span>
        ))}
      </div>

      <div className="relative -mx-2 h-[220px] text-fg">
        <StatusMessage message={message} className="absolute inset-0 z-10" />
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barGap={2} barCategoryGap="20%">
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" strokeOpacity={0.08} />
            <XAxis dataKey="date" axisLine={false} tickLine={false} minTickGap={24}
              tick={{ fill: 'currentColor', fillOpacity: 0.55, fontSize: 10 }}
              tickFormatter={(date: unknown) => (typeof date === 'string' ? formatBucketDate(date) : '')} />
            <YAxis orientation="right" axisLine={false} tickLine={false} width={56}
              tick={{ fill: 'currentColor', fillOpacity: 0.55, fontSize: 10 }}
              tickFormatter={(value: number) => Math.round(value).toLocaleString('ko-KR')} />
            <Tooltip
              contentStyle={{ backgroundColor: colors.surface, border: `1px solid ${colors.line}`, borderRadius: 8, fontSize: 11, boxShadow: 'none' }}
              labelFormatter={(date: unknown) => (typeof date === 'string' ? `${weekly ? '주 시작 ' : ''}${date}` : '')}
              formatter={(value: unknown, name: unknown, entry: { payload?: { counts?: CapitalBucket } }) => {
                const series = SERIES.find(item => item.key === name)
                const counts = entry?.payload?.counts
                const count = !counts ? null : name === 'dilution' ? counts.dilutionCount : name === 'shareholderReturn' ? counts.shareholderReturnCount : counts.treasuryDisposalCount
                return [`${Math.round(Number(value)).toLocaleString('ko-KR')}억원${count !== null ? ` · ${count}건` : ''}`, series?.label ?? String(name)]
              }}
              cursor={{ fill: 'currentColor', fillOpacity: 0.04 }}
            />
            {SERIES.map(series => (
              <Bar key={series.key} dataKey={series.key} fill={colors[series.token]} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {(() => {
        const missing = buckets.reduce((sum, bucket) => sum + bucket.missingAmountCount, 0)
        return (
          <p className="mt-1 text-[10px] text-fg-muted">
            {missing > 0 ? `금액을 알 수 없는 사건 ${missing}건(주식 소각 등)은 합계에 넣지 않았습니다. ` : ''}
            {since ? `${since} 이후 수집분 기준입니다.` : ''}
          </p>
        )
      })()}

      <div className="mt-4">
        <h4 className="mb-1 text-[11px] font-medium text-fg-muted">금액이 큰 이벤트</h4>
        {top.length === 0 ? (
          <p className="text-xs text-fg-muted">—</p>
        ) : (
          <ul>
            {top.map(item => (
              <li key={item.rceptNo} className="flex items-center justify-between gap-2 py-1 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={cn(badgeClass, groupBadgeClass(item.group))}>{kindLabel(item.kind) ?? groupLabel(item.group)}</span>
                  <span className="truncate text-fg">{item.corpName}</span>
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-fg">{formatKrw(item.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function DisclosureDashboard() {
  const [group, setGroup] = useState('all')
  const [range, setRange] = useState('1개월')
  const { data, status } = useCapitalEvents(range)
  // 요약 수치: 오늘 공시 건수는 전체 목록에서 센다
  const { items: allItems } = useRecentDisclosures('all')
  const today = seoulToday()
  const todayCount = allItems.filter(item => item.rceptDate === today).length
  const buckets = data?.buckets ?? []
  const dilution = buckets.reduce((sum, bucket) => sum + bucket.dilution, 0)
  const shareholderReturn = buckets.reduce((sum, bucket) => sum + bucket.shareholderReturn, 0)

  return (
    <div className="flex w-full flex-col gap-5">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="오늘 공시" value={`${todayCount.toLocaleString('ko-KR')}건${todayCount >= 100 ? '+' : ''}`} />
        <StatTile label={`희석 합계 (${range})`} value={status === 'loaded' ? formatKrw(dilution) : '—'} tone="down" />
        <StatTile label={`주주환원 합계 (${range})`} value={status === 'loaded' ? formatKrw(shareholderReturn) : '—'} tone="up" />
      </motion.div>

      <div className="grid w-full grid-cols-1 gap-5 lg:grid-cols-5">
        <motion.div className="lg:col-span-3" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.04, ease: [0.16, 1, 0.3, 1] }}>
          <DisclosureFeed group={group} setGroup={setGroup} />
        </motion.div>
        <motion.div className="lg:col-span-2" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}>
          <CapitalEventsCard range={range} setRange={setRange} buckets={buckets} top={data?.top ?? []} since={data?.since ?? null}
            status={status} weekly={data?.bucket === 'week'} />
        </motion.div>
      </div>
    </div>
  )
}
