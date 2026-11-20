import { useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { formatNumber } from '@/lib/format'
import { formatWonShort, RANKING_MARKETS, RANKING_VIEWS, type RankingItem, type RankingView } from '@/lib/rankings'
import { useRankings } from '@/hooks/useAnalytics'
import { SegmentedControl } from '@/components/common/SegmentedControl'
import { StatusMessage } from '@/components/common/StatusMessage'
import { CARD_FRAME, statusText } from '@/lib/ui'

// 종목 순위 탭 (docs/Task_ORDER.md 15단계 T-113, D-72)
// KRX 종목별 일별매매정보에서 시장·날짜마다 상승률·하락률·거래대금·시가총액 상위 100개를 보여 준다(장 마감 후 하루 1번).
// 등락률만 등락 색 규칙(상승 초록·하락 빨강, D-32)을 따른다. 이미지(로고 등)는 쓰지 않는다.

// 카드 틀·상태 문구는 공통(lib/ui.ts, plan.md FQA-08, T-221)
const cardClass = CARD_FRAME

const rateClass = (rate: number | null) => (rate === null || rate === 0 ? 'text-fg' : rate > 0 ? 'text-up' : 'text-down')
const formatRate = (rate: number | null) => (rate === null ? '—' : `${rate > 0 ? '+' : ''}${rate.toFixed(2)}%`)

function RankingTable({ items }: { items: RankingItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-[12px]">
        <thead className="text-[11px] text-fg-muted">
          <tr className="border-b border-line">
            <th className="w-10 py-2 font-medium">순위</th>
            <th className="py-2 font-medium">종목</th>
            <th className="py-2 text-right font-medium">종가</th>
            <th className="py-2 text-right font-medium">등락률</th>
            <th className="py-2 text-right font-medium">거래대금</th>
            <th className="py-2 text-right font-medium">시가총액</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr key={item.code} className="border-b border-line last:border-b-0">
              <td className="py-2 tabular-nums text-fg-muted">{item.rank}</td>
              <td className="py-2">
                <div className="truncate font-medium text-fg">{item.name}</div>
                <div className="text-[10px] tabular-nums text-fg-muted">{item.code}</div>
              </td>
              <td className="py-2 text-right tabular-nums text-fg">{formatNumber(item.close, 0)}</td>
              <td className={cn('py-2 text-right font-semibold tabular-nums', rateClass(item.changeRate))}>{formatRate(item.changeRate)}</td>
              <td className="py-2 text-right tabular-nums text-fg">{formatWonShort(item.tradingValue)}</td>
              <td className="py-2 text-right tabular-nums text-fg">{formatWonShort(item.marketCap)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function RankingsDashboard() {
  const [market, setMarket] = useState<string>('KOSPI')
  const [view, setView] = useState<RankingView>('gain')
  const [date, setDate] = useState<string | null>(null) // null = 가장 최근 거래일
  const { data, status } = useRankings(market, view, date)
  const coverage = data?.coverage[market] ?? null
  const items = data?.items ?? []
  const message = statusText(status, items.length === 0,
    date ? '이 날의 순위가 없습니다 (휴장일이거나 수집 전)' : '종목 순위를 준비하고 있습니다 (KRX 일별매매정보 수집 후 표시)')

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="flex w-full flex-col gap-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl label="시장 선택" options={RANKING_MARKETS} value={market} onChange={setMarket} />
          {/* 한 화면에 선택 묶음이 둘이라 두 번째(기준)는 옅게 구분한다(예전과 같은 모양) */}
          <SegmentedControl wrap tone="soft" label="순위 기준 선택" options={RANKING_VIEWS} value={view} onChange={setView} />
        </div>
        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          기준일
          <input type="date" value={date ?? data?.date ?? ''} min={coverage?.since} max={coverage?.until}
            onChange={event => setDate(event.target.value || null)}
            className="rounded-md border border-line bg-surface px-2 py-1 text-[12px] tabular-nums text-fg outline-none focus-visible:ring-1 focus-visible:ring-neon" />
          {date && <button type="button" onClick={() => setDate(null)} className="rounded-md px-1.5 py-1 text-[11px] hover:bg-fg/5 hover:text-fg">최근</button>}
        </label>
      </div>

      <div className={cn(cardClass, 'p-4 md:p-5')}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium text-fg-muted">
            {RANKING_VIEWS.find(item => item.key === view)?.label} 상위 {items.length || 100}
          </h3>
          {data?.date && <span className="inline-flex items-center rounded-full border border-line px-1.5 py-px text-[10px] font-medium leading-4 text-fg-muted">기준일 {data.date}</span>}
        </div>
        {/* 불러오는 중에는 골격, 그 밖은 글 (plan.md FQA-16, T-222). 받은 뒤 표 높이는 행 수에 따라 달라 이 영역은 높이가 바뀐다 */}
        {message ? <StatusMessage message={message} className="h-40" /> : <RankingTable items={items} />}
      </div>

      <p className="text-[11px] leading-relaxed text-fg-muted">
        출처: KRX Open API 종목별 일별매매정보(장 마감 후 갱신). 시장·날짜마다 기준별 상위 100개만 저장하며 1년 보관합니다.
        상승 종목이 100개보다 적은 날은 상승률 목록도 짧습니다.
      </p>
    </motion.div>
  )
}
