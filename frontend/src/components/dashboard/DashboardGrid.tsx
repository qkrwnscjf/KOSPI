import { CATEGORY_DATA, type ChartCardConfig } from '@/constants/data'
import { ChartCard } from './ChartCard'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { formatClock } from '@/lib/format'
import { useConnectionStatus, useLastReceivedAt } from '@/hooks/useMarketData'
import { DisclosureDashboard } from '@/components/disclosures/DisclosureDashboard'
import { RiskDashboard } from '@/components/risk/RiskDashboard'
import { EarningsCalendar } from '@/components/calendar/EarningsCalendar'
import { RankingsDashboard } from '@/components/rankings/RankingsDashboard'
import { MarketFlowsReport } from '@/components/flows/MarketFlowsReport'
import { SectorNodes } from './SectorNodes'
import { MarketBreadthPanel } from './MarketBreadth'

interface DashboardGridProps {
  categoryId: string
}

const categoryNames: Record<string, string> = {
  category1: '국내 전광판',
  category2: '매크로 및 환율',
  category3: '글로벌 연동',
  category4: '국내 섹터 모멘텀',
  category5: '증시 자금 흐름',
  category6: '공시·자본 이벤트',
  category7: '시장 연관성·리스크',
  category8: '실적·배당 캘린더',
  category9: '종목 순위',
}

const categoryDescriptions: Record<string, string> = {
  category1: ' 코스피·코스닥·코스피 200과 대형주 3종의 실시간 시세, KRX 대표 지수의 일별 시세, 시장 폭(상승·하락 종목 수)과 거래대금을 보여 줍니다.',
  category2: ' 원화 환율, 미국 국채 금리와 장단기 금리차, 변동성 지수를 보여 줍니다.',
  category3: ' 미국·아시아 주요 지수와 에너지·금속 원자재 선물을 보여 줍니다.',
  category4: ' KRX 섹터 지수 17종의 기간 수익률을 노드로 비교하고, 섹터별 추이를 확인합니다. 섹터 지수는 KRX 일별 시세입니다.',
  category5: ' 투자자예탁금·신용융자·미수금·반대매매 등 증시 주변 자금의 최근 1개월 일별 추이를 보여 줍니다(금융투자협회 종합통계).',
  category6: ' 새 공시와 증자·사채 발행(희석), 자사주 취득·소각(주주환원) 규모를 보여 줍니다.',
  category7: ' 코스피가 해외 지수·환율·변동성·금리와 얼마나 같이 움직였는지(상관계수·베타)와 지표별 변동성·최대 낙폭을 기간별로 보여 줍니다.',
  category8: ' 유가증권시장의 잠정실적·배당 결정·정기보고서 공시를 달력에서 날짜별로 보고, 날짜를 누르면 원문 링크를 확인합니다.',
  category9: ' 유가증권·코스닥의 상승률·하락률·거래대금·시가총액 상위 100개 종목을 날짜별로 보여 줍니다.',
}

// 카드를 소분류(group)별로 묶는다. 처음 나온 순서를 지킨다 (T-108)
function groupCharts(charts: ChartCardConfig[]) {
  const groups: { name: string; charts: ChartCardConfig[] }[] = []
  for (const chart of charts) {
    const name = chart.group ?? ''
    const found = groups.find(group => group.name === name)
    if (found) found.charts.push(chart)
    else groups.push({ name, charts: [chart] })
  }
  return groups
}

// 하단 상태 표시는 고정 문구가 아니라 실제 연결 상태와 마지막 수신 시각을 보여 준다 (T-33).
// 이전에는 항상 "All Systems Operational"과 화면을 그린 시각을 보여 줬다.
const STATUS_TEXT = {
  connecting: '연결 중',
  connected: '실시간 연결됨',
  disconnected: '연결 끊김 · 재연결 중',
} as const

function StatusFooter() {
  const status = useConnectionStatus()
  const lastReceivedAt = useLastReceivedAt()

  return (
    <footer className="mt-24 flex w-full flex-col items-center justify-between gap-6 border-t border-line pb-16 pt-10 md:flex-row">
      <div className="flex items-center gap-8">
        <div className="flex flex-col items-center gap-1 md:items-start">
          <span className="text-[11px] font-medium text-fg-muted">연결 상태</span>
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                status === 'connected' ? 'bg-fg' : status === 'disconnected' ? 'bg-down' : 'bg-fg-muted'
              )}
            />
            <span className={cn('text-xs font-medium', status === 'disconnected' && 'text-down')}>{STATUS_TEXT[status]}</span>
          </div>
        </div>
        <div className="flex flex-col items-center gap-1 md:items-start">
          <span className="text-[11px] font-medium text-fg-muted">마지막 데이터 수신</span>
          <span className="text-xs font-medium tabular-nums">{lastReceivedAt ? formatClock(lastReceivedAt) : '—'}</span>
        </div>
      </div>

      <span className="text-[11px] text-fg-muted">시세 출처: Yahoo Finance(일부 10~15분 지연) · KRX Open API(일별) · 공시: 금융감독원 DART · 증시 자금: 금융투자협회(공공데이터포털)</span>
    </footer>
  )
}

export function DashboardGrid({ categoryId }: DashboardGridProps) {
  const charts = CATEGORY_DATA[categoryId] || []
  // 카드가 모두 수집 보류 중인 카테고리는 이유를 먼저 알려 준다 (T-44)
  const allPending = charts.length > 0 && charts.every(chart => !chart.ready)

  return (
    <div className="flex w-full flex-col items-center">
      {/* 사이드바 옆에 붙도록 제목은 왼쪽 정렬 (T-68) */}
      <header className="mb-10 mt-8 flex w-full flex-col items-start lg:mt-12">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="h-1.5 w-1.5 rounded-full bg-neon shadow-[0_0_8px_rgb(var(--color-neon))]" />
          <span className="text-[11px] font-semibold tracking-[0.25em] text-fg-muted">MARKET OVERVIEW</span>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={categoryId}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col items-start"
          >
            <h2 className="mb-3 text-3xl font-bold tracking-tight text-fg md:text-4xl">
              {categoryNames[categoryId]}
            </h2>
            <p className="max-w-2xl text-xs leading-relaxed text-fg-muted md:text-sm">
              실시간 시장 데이터를 기반으로 한 종합 모니터링 대시보드입니다.
              {categoryDescriptions[categoryId] ?? ' 주요 지표의 추세와 변동성을 정밀하게 분석합니다.'}
            </p>
          </motion.div>
        </AnimatePresence>
      </header>

      {allPending && (
        <div className="mb-6 w-full rounded-xl border border-dashed border-line px-4 py-3 text-center text-xs text-fg-muted">
          이 카테고리의 지표는 데이터 수집을 준비하고 있습니다. 준비가 끝나면 실제 값이 표시됩니다.
        </div>
      )}

      {/* 증시 자금 흐름 탭: 금융투자협회 일별 통계 1개월 (11단계 B′ T-98, D-77). 투자자별 순매수 화면은 원천이 없어 T-164에서 지웠다 */}
      {categoryId === 'category5' ? (
        <MarketFlowsReport />
      ) : categoryId === 'category6' ? (
        <DisclosureDashboard />
      ) : categoryId === 'category7' ? (
        <RiskDashboard />
      ) : categoryId === 'category8' ? (
        <EarningsCalendar />
      ) : categoryId === 'category9' ? (
        <RankingsDashboard />
      ) : (
      <>
      {/* 국내 섹터 모멘텀: 위쪽에 섹터 수익률 노드 (D-66) */}
      {categoryId === 'category4' && <SectorNodes />}
      {/* 소분류(group)별로 제목을 달아 묶는다 (T-108). group이 없는 카테고리는 묶음 하나로 이전과 같다 */}
      <div className="flex w-full flex-col gap-10">
        {groupCharts(charts).map(group => (
          <section key={`${categoryId}-${group.name}`} className="w-full" aria-label={group.name || undefined}>
            {group.name && (
              <h3 className="mb-4 flex items-center gap-2 text-[12px] font-semibold tracking-wide text-fg-muted">
                {group.name}
                <span className="text-[11px] font-normal">{group.charts.length}</span>
              </h3>
            )}
            <motion.div
              layout
              className={cn(
                'grid w-full gap-5',
                categoryId === 'category4'
                  ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
                  : 'grid-cols-1 md:grid-cols-2'
              )}
            >
              <AnimatePresence mode="popLayout">
                {group.charts.map((chart, index) => (
                  <motion.div
                    key={`${categoryId}-${chart.symbol}`}
                    id={`card-${chart.symbol}`}
                    layout
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                    transition={{
                      duration: 0.4,
                      delay: index * 0.04,
                      ease: [0.16, 1, 0.3, 1],
                    }}
                    className={cn(categoryId === 'category4' && index === 0 ? 'lg:col-span-2 lg:row-span-1' : '')}
                  >
                    <ChartCard {...chart} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          </section>
        ))}
        {/* 국내 전광판: 아래쪽에 시장 폭·거래대금 (T-106) */}
        {categoryId === 'category1' && <MarketBreadthPanel />}
      </div>
      </>
      )}

      <StatusFooter />
    </div>
  )
}
