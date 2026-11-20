import { useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/format'
import { correlationBar, correlationStrength, formatSigned, RISK_LABELS, RISK_RANGES, type PairStats, type SeriesStats, type TargetRisk } from '@/lib/risk'
import { useMarketRisk } from '@/hooks/useMarketRisk'
import { CARD_FRAME, STATUS_TEXT, statusText } from '@/lib/ui'
import { SegmentedControl, segmentsOf } from '@/components/common/SegmentedControl'
import { StatusMessage } from '@/components/common/StatusMessage'

// 시장 연관성·리스크 탭 (docs/Task_ORDER.md 15단계 T-110, D-72)
// 코스피와 해외 지수·환율·변동성·금리가 얼마나 같이 움직이는지(상관계수·베타)와, 지표별 변동성·최대 낙폭을 보여 준다.
// 이미 저장된 일봉으로 서버가 계산한 값이다(저장하지 않음). 데이터 막대는 흑백, 등락 수치만 등락 색 규칙(D-32)을 따른다.

const cardClass = cn(CARD_FRAME, 'flex flex-col p-5')
const badgeClass = 'inline-flex items-center rounded-full border border-line px-1.5 py-px text-[10px] font-medium leading-4 text-fg-muted'

const changeColor = (value: number | null) => (value === null || value === 0 ? 'text-fg' : value > 0 ? 'text-up' : 'text-down')

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-fg-muted">{label}</span>
      <span className={cn('text-sm font-semibold tabular-nums text-fg', className)}>{value}</span>
    </div>
  )
}

// 기간 변화·연환산 변동성·최대 낙폭. 금리는 %p
function StatsRow({ stats, mode }: { stats: SeriesStats; mode: 'return' | 'change' }) {
  const unit = mode === 'return' ? '%' : '%p'
  return (
    <div className="grid grid-cols-3 gap-3">
      <Stat label={mode === 'return' ? '기간 수익률' : '기간 변화'} value={formatSigned(stats.periodChange, 2, unit)} className={changeColor(stats.periodChange)} />
      <Stat label="변동성 (연환산)" value={stats.volatility === null ? '—' : `${stats.volatility.toFixed(mode === 'return' ? 1 : 2)}${unit}`} />
      <Stat label="최대 낙폭" value={stats.maxDrawdown === null ? '—' : `${stats.maxDrawdown.toFixed(1)}%`} className={stats.maxDrawdown ? 'text-down' : ''} />
    </div>
  )
}

// 상관계수 막대: 가운데가 0, 오른쪽이 같은 방향(+1), 왼쪽이 반대 방향(−1)
function CorrelationRow({ label, pair, unit }: { label: string; pair: PairStats; unit: string }) {
  const bar = correlationBar(pair.correlation)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-fg-muted">{label}</span>
        <span className="tabular-nums text-fg">
          <b className="font-semibold">{formatSigned(pair.correlation, 2)}</b>
          <span className="ml-1.5 text-fg-muted">{correlationStrength(pair.correlation)}</span>
        </span>
      </div>
      <div className="relative h-1.5 w-full rounded-full bg-fg/5" aria-hidden>
        <span className="absolute inset-y-0 left-1/2 w-px bg-fg/30" />
        <span className="absolute inset-y-0 rounded-full bg-fg/70" style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />
      </div>
      <div className="text-[10px] tabular-nums text-fg-muted">
        베타 {pair.beta === null ? '—' : pair.beta.toFixed(2)}
        <span className="ml-1">(상대가 1{unit} 움직일 때 코스피 {pair.beta === null ? '—' : formatSigned(pair.beta, 2, '%')})</span>
        <span className="ml-1.5">· 표본 {pair.pairs}일</span>
      </div>
    </div>
  )
}

function TargetCard({ target }: { target: TargetRisk }) {
  const unit = target.mode === 'return' ? '%' : '%p'
  return (
    <div className={cardClass}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="text-[13px] font-medium text-fg-muted">{RISK_LABELS[target.symbol] ?? target.symbol}</h3>
        {target.mode === 'change' && <span className={badgeClass}>변화량 기준</span>}
      </div>
      <div className="mb-4 flex flex-col gap-3">
        <CorrelationRow label="같은 날 (동시)" pair={target.sameDay} unit={unit} />
        <CorrelationRow label="전 거래일 → 코스피 (선행)" pair={target.lagged} unit={unit} />
      </div>
      <div className="mt-auto border-t border-line pt-3">
        <StatsRow stats={target.stats} mode={target.mode} />
      </div>
    </div>
  )
}

export function RiskDashboard() {
  const [range, setRange] = useState<string>('3개월')
  const { data, status } = useMarketRisk(range)
  // 상태 문구는 공통(lib/ui.ts, plan.md FQA-08, T-221)
  const message = statusText(status, !data || data.base.stats.points < 2, '계산할 일봉이 아직 없습니다')

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="flex w-full flex-col gap-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-xs leading-relaxed text-fg-muted">
          상관계수는 일간 수익률(금리는 일간 변화량)로 계산하며, 1에 가까울수록 같은 방향, −1에 가까울수록 반대 방향으로 움직였다는 뜻입니다.
          해외 지표와 환율은 한국 장보다 늦게 닫혀서 <b className="font-medium text-fg">전 거래일 값이 다음 날 코스피에 주는 영향(선행)</b>을 함께 보여 줍니다.
          장중인 오늘 값은 빼고 확정된 일봉만 씁니다.
        </p>
        <SegmentedControl label="기간 선택" options={segmentsOf<string>(RISK_RANGES)} value={range} onChange={setRange} />
      </div>

      {message || !data ? (
        // 불러오는 중에는 골격, 그 밖은 글 (plan.md FQA-16, T-222)
        <StatusMessage message={message ?? STATUS_TEXT.empty} className={cn(CARD_FRAME, 'h-[240px] w-full border-dashed')} />
      ) : (
        <>
          <div className={cardClass}>
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h3 className="text-[13px] font-medium text-fg-muted">{RISK_LABELS[data.base.symbol] ?? data.base.symbol} (기준)</h3>
                <div className="mt-0.5 text-[11px] tabular-nums text-fg-muted">
                  {data.base.stats.lastTime !== null && `마지막 일봉 ${formatDate(data.base.stats.lastTime, true)} · 일봉 ${data.base.stats.points}개`}
                </div>
              </div>
              <span className={badgeClass}>일별</span>
            </div>
            <StatsRow stats={data.base.stats} mode="return" />
          </div>
          <div className="grid w-full grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {data.targets.map(target => <TargetCard key={target.symbol} target={target} />)}
          </div>
          <p className="text-[11px] leading-relaxed text-fg-muted">
            출처: Yahoo Finance 일봉(1년 그래프와 같은 데이터)으로 계산. 표본이 10일보다 적으면 계산하지 않습니다. 과거의 관계가 앞으로도 같다는 뜻은 아닙니다.
          </p>
        </>
      )}
    </motion.div>
  )
}
