import { CATEGORY_DATA, type ChartCardConfig } from '@/constants/data'
import { ChartCard } from './ChartCard'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { formatClock } from '@/lib/format'
import { useConnectionStatus, useLastReceivedAt } from '@/hooks/useMarketData'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { tabById } from '@/constants/tabs'

interface DashboardGridProps {
  categoryId: string
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

      <span className="text-[11px] text-fg-muted">시세 출처: Yahoo Finance(일부 지연 시세, 카드에 장중 실측 지연 표시) · KRX Open API(일별) · 공시: 금융감독원 DART · 증시 자금: 금융투자협회(공공데이터포털)</span>
    </footer>
  )
}

export function DashboardGrid({ categoryId }: DashboardGridProps) {
  const charts = CATEGORY_DATA[categoryId] || []
  // 카드가 모두 수집 보류 중인 카테고리는 이유를 먼저 알려 준다 (T-44)
  const allPending = charts.length > 0 && charts.every(chart => !chart.ready)
  // 이름·설명·화면은 탭 정의 한 곳에서 가져온다 (plan.md FQA-06, T-202)
  const tab = tabById(categoryId)
  const View = tab?.view
  const Above = tab?.above
  const Below = tab?.below

  return (
    <div className="flex w-full flex-col items-center">
      {/* 사이드바 옆에 붙도록 제목은 왼쪽 정렬 (T-68) */}
      <header className="mb-10 mt-8 flex w-full flex-col items-start lg:mt-12">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="h-1.5 w-1.5 rounded-full bg-neon shadow-[0_0_8px_rgb(var(--color-neon))]" />
          <span className="text-[11px] font-semibold tracking-[0.25em] text-fg-muted">시장 개요</span>
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
              {tab?.name}
            </h2>
            {/* 탭마다 자기 설명만 쓴다 (plan.md FQA-15, T-204). 예전에는 일별·캘린더·순위 탭에도 "실시간 시장 데이터…" 고정 문장이 붙었다 */}
            <p className="max-w-2xl text-xs leading-relaxed text-fg-muted md:text-sm">
              {tab?.description}
            </p>
          </motion.div>
        </AnimatePresence>
      </header>

      {allPending && (
        <div className="mb-6 w-full rounded-xl border border-dashed border-line px-4 py-3 text-center text-xs text-fg-muted">
          이 카테고리의 지표는 데이터 수집을 준비하고 있습니다. 준비가 끝나면 실제 값이 표시됩니다.
        </div>
      )}

      {/* 탭 단위 오류 경계 (plan.md FQA-07, T-200): 탭을 바꾸면(key) 새로 시작한다 */}
      <ErrorBoundary key={categoryId} scope="tab" label={tab?.name ?? '이'}>
      {/* 전용 화면이 있는 탭(자금 흐름·공시·캘린더·순위·리스크)은 그 화면, 나머지는 카드 그리드 */}
      {View ? (
        <View />
      ) : (
      <>
      {/* 카드 위 패널(섹터 수익률 노드, D-66) */}
      {Above && <Above />}
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
            {/* 그리드 묶음 자체의 layout 측정은 뺐다 (plan.md FQA-04, T-195). 카드 위치 애니메이션은 아래 항목의 layout이 맡는다 */}
            <div
              className={cn(
                'grid w-full gap-5',
                tab?.denseGrid
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
                    className={cn(tab?.denseGrid && index === 0 ? 'lg:col-span-2 lg:row-span-1' : '')}
                  >
                    {/* 카드 단위 오류 경계 (FQA-07, T-200): 카드 하나의 오류가 탭 전체를 멈추지 않게 */}
                    <ErrorBoundary scope="card" label={chart.title}>
                      <ChartCard {...chart} />
                    </ErrorBoundary>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </section>
        ))}
        {/* 카드 아래 패널(국내 전광판의 시장 폭·거래대금, T-106) */}
        {Below && <Below />}
      </div>
      </>
      )}
      </ErrorBoundary>

      <StatusFooter />
    </div>
  )
}
