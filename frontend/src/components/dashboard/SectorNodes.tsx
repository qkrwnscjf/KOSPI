import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Building2, CandlestickChart, Car, ChevronLeft, ChevronRight, Clapperboard, Cog, Cpu, Factory, FlaskConical, HeartPulse,
  Landmark, Monitor, RadioTower, ShieldCheck, ShoppingBag, ShoppingCart, Truck, Zap, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/format'
import { formatReturn, rankSectors, returnDirection, returnIntensity, SECTOR_LABELS } from '@/lib/sectors'
import { useSectorReturns } from '@/hooks/useSectorReturns'
import { SegmentedControl, segmentsOf } from '@/components/common/SegmentedControl'
import { StatusMessage } from '@/components/common/StatusMessage'
import { CARD_FRAME, statusText } from '@/lib/ui'

// 섹터 수익률 노드 (docs/Task_ORDER.md D-66)
// 국내 섹터 모멘텀 탭 위쪽에 섹터를 노드로 놓고 기간 수익률을 보여 준다. 수익률 높은 순으로 정렬한다.
// - 이미지: 외부 이미지 대신 번들에 포함된 아이콘(lucide-react)을 쓴다(외부 요청·저작권 문제 없음)
// - 색: 상승 초록·하락 빨강(D-32), 진하기는 기간 안 최대 등락 대비 크기. 네온 강조색은 데이터에 쓰지 않는다(D-54)
// - 노드를 누르면 아래 해당 섹터 카드로 이동한다

const RANGES = ['1주', '1개월', '3개월', '1년']

const SECTOR_ICONS: Record<string, LucideIcon> = {
  KRX_SEMI: Cpu,
  KRX_IT: Monitor,
  KRX_AUTO: Car,
  KRX_BANK: Landmark,
  KRX_BIO: HeartPulse,
  KRX_ENERGY_CHEM: FlaskConical,
  KRX_STEEL: Factory,
  KRX_TELECOM: RadioTower,
  KRX_CONSTRUCTION: Building2,
  KRX_SECURITIES: CandlestickChart,
  KRX_MACHINERY: Cog,
  KRX_INSURANCE: ShieldCheck,
  KRX_TRANSPORT: Truck,
  KRX_CONS_DISC: ShoppingBag,
  KRX_CONS_STAPLES: ShoppingCart,
  KRX_KCONTENT: Clapperboard,
  KRX_UTILITIES: Zap,
}

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

const scrollToCard = (symbol: string) =>
  document.getElementById(`card-${symbol}`)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' })

// 노드가 한 줄을 넘칠 때만 좌우 넘김 버튼을 보인다. 스크롤 위치·창 크기·노드 수가 바뀌면 다시 판단한다
function useHorizontalOverflow(deps: unknown[]) {
  const ref = useRef<HTMLUListElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const update = useCallback(() => {
    const element = ref.current
    if (!element) return
    setEdges({
      left: element.scrollLeft > 4,
      right: element.scrollLeft + element.clientWidth < element.scrollWidth - 4,
    })
  }, [])
  useEffect(() => {
    const element = ref.current
    if (!element) return
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    element.addEventListener('scroll', update, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', update)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update, ...deps])
  const scrollByPage = (direction: -1 | 1) => {
    const element = ref.current
    if (!element) return
    element.scrollBy({ left: direction * element.clientWidth * 0.8, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }
  return { ref, edges, scrollByPage }
}

const arrowClass =
  'absolute top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-surface text-fg shadow-sm transition-colors hover:border-neon/50 hover:text-neon'

export function SectorNodes() {
  const [range, setRange] = useState('1개월')
  const { data, status } = useSectorReturns(range)
  const ranked = rankSectors(data)
  const maxAbs = Math.max(0, ...ranked.map(sector => Math.abs(sector.returnPct ?? 0)))
  const baseTime = Math.max(0, ...ranked.map(sector => sector.lastTime))
  const { ref: listRef, edges, scrollByPage } = useHorizontalOverflow([status, ranked.length])

  return (
    <div className={cn(CARD_FRAME, 'mb-6 w-full p-5')}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-medium text-fg-muted">
          섹터 수익률 <span className="text-[11px]">(기간 첫 거래일 종가 대비, 높은 순{baseTime > 0 ? ` · 기준일 ${formatDate(baseTime, true)}` : ''})</span>
        </h3>
        <SegmentedControl label="섹터 수익률 기간 선택" options={segmentsOf(RANGES)} value={range} onChange={setRange} />
      </div>

      {status !== 'loaded' || ranked.length === 0 ? (
        // 상태 문구·골격은 공통 (plan.md FQA-08 · 16, T-221 · T-222)
        <StatusMessage message={statusText(status, true)} className="h-28" />
      ) : (
        // 한 줄로 나열한다. 넓은 화면에서는 고르게 펼치고, 넘치면 좌우 버튼·밀기로 넘긴다
        <div className="relative">
        {edges.left && (
          <>
            <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-[5] w-10 bg-gradient-to-r from-surface to-transparent" />
            <button type="button" onClick={() => scrollByPage(-1)} aria-label="이전 섹터 보기" className={cn(arrowClass, '-left-2')}>
              <ChevronLeft className="h-4 w-4" />
            </button>
          </>
        )}
        {edges.right && (
          <>
            <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-[5] w-10 bg-gradient-to-l from-surface to-transparent" />
            <button type="button" onClick={() => scrollByPage(1)} aria-label="다음 섹터 보기" className={cn(arrowClass, '-right-2')}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </>
        )}
        <ul ref={listRef} className="no-scrollbar -mx-1 flex flex-nowrap justify-between gap-1 overflow-x-auto px-1 pb-1">
          {ranked.map((sector, index) => {
            const Icon = SECTOR_ICONS[sector.symbol] ?? Cog
            const label = SECTOR_LABELS[sector.symbol] ?? sector.symbol
            const direction = returnDirection(sector.returnPct)
            const intensity = returnIntensity(sector.returnPct, maxAbs)
            const tone = direction === 'up' ? '--color-up' : direction === 'down' ? '--color-down' : '--color-fg-muted'
            return (
              <motion.li key={sector.symbol} layout className="shrink-0" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.3, delay: index * 0.015, ease: [0.16, 1, 0.3, 1] }}>
                <button
                  type="button"
                  onClick={() => scrollToCard(sector.symbol)}
                  aria-label={`${label} ${range} 수익률 ${formatReturn(sector.returnPct)}. 누르면 카드로 이동`}
                  className="group flex w-[58px] flex-col items-center gap-1"
                >
                  <span
                    className="flex h-10 w-10 items-center justify-center rounded-full border-2 transition-transform duration-200 group-hover:scale-105"
                    style={{
                      borderColor: `rgb(var(${tone}) / ${0.35 + 0.65 * intensity})`,
                      backgroundColor: `rgb(var(${tone}) / ${0.06 + 0.2 * intensity})`,
                    }}
                  >
                    <Icon className="h-[18px] w-[18px] text-fg" aria-hidden />
                  </span>
                  <span className="whitespace-nowrap text-[10px] font-medium text-fg">{label}</span>
                  <span className={cn('text-[11px] font-semibold tabular-nums',
                    direction === 'up' ? 'text-up' : direction === 'down' ? 'text-down' : 'text-fg-muted')}>
                    {formatReturn(sector.returnPct)}
                  </span>
                </button>
              </motion.li>
            )
          })}
        </ul>
        </div>
      )}
    </div>
  )
}
