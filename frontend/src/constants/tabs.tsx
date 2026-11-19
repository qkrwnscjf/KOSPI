import type { ComponentType } from 'react'
import { LayoutDashboard, Globe, TrendingUp, Activity, ArrowLeftRight, FileText, Network, CalendarDays, ListOrdered, type LucideIcon } from 'lucide-react'
import { DisclosureDashboard } from '@/components/disclosures/DisclosureDashboard'
import { RiskDashboard } from '@/components/risk/RiskDashboard'
import { EarningsCalendar } from '@/components/calendar/EarningsCalendar'
import { RankingsDashboard } from '@/components/rankings/RankingsDashboard'
import { MarketFlowsReport } from '@/components/flows/MarketFlowsReport'
import { SectorNodes } from '@/components/dashboard/SectorNodes'
import { MarketBreadthPanel } from '@/components/dashboard/MarketBreadth'

// 탭 정의 (plan.md FQA-06, T-202): 이름·설명·순서·아이콘·URL·화면을 이 한 곳에서 정한다.
// 예전에는 사이드바(이름·순서·아이콘), 화면 제목, 설명, 화면 분기가 따로 있어 탭을 더하려면 여러 곳을 고쳐야 했다.
// 카드 목록(constants/data.ts의 CATEGORY_DATA)은 같은 id로 찾는다.
// - view: 카드 그리드 대신 보여 줄 화면. 없으면 카드 그리드
// - above / below: 카드 그리드 위·아래에 붙는 패널
export interface TabDefinition {
  id: string
  slug: string
  name: string
  description: string
  icon: LucideIcon
  view?: ComponentType
  above?: ComponentType
  below?: ComponentType
  denseGrid?: boolean // 카드가 많아 한 줄에 더 놓는 탭(섹터)
}

// 사이드바 순서 그대로
export const TABS: readonly TabDefinition[] = [
  { id: 'category1', slug: 'domestic', name: '국내 전광판', icon: LayoutDashboard, below: MarketBreadthPanel,
    description: '코스피·코스닥·코스피 200과 대형주 3종의 실시간 시세, KRX 대표 지수의 일별 시세, 시장 폭(상승·하락 종목 수)과 거래대금을 보여 줍니다.' },
  { id: 'category2', slug: 'macro', name: '매크로 및 환율', icon: Globe,
    description: '원화 환율, 미국 국채 금리와 장단기 금리차, 변동성 지수를 보여 줍니다.' },
  { id: 'category3', slug: 'global', name: '글로벌 연동', icon: TrendingUp,
    description: '미국·아시아 주요 지수와 에너지·금속 원자재 선물을 보여 줍니다.' },
  { id: 'category4', slug: 'sectors', name: '국내 섹터 모멘텀', icon: Activity, above: SectorNodes, denseGrid: true,
    description: 'KRX 섹터 지수 17종의 기간 수익률을 노드로 비교하고, 섹터별 추이를 확인합니다. 섹터 지수는 KRX 일별 시세입니다.' },
  { id: 'category5', slug: 'flows', name: '증시 자금 흐름', icon: ArrowLeftRight, view: MarketFlowsReport,
    description: '투자자예탁금·신용융자·미수금·반대매매 등 증시 주변 자금의 최근 1개월 일별 추이를 보여 줍니다(금융투자협회 종합통계).' },
  { id: 'category6', slug: 'disclosures', name: '공시·자본 이벤트', icon: FileText, view: DisclosureDashboard,
    description: '새 공시와 증자·사채 발행(희석), 자사주 취득·소각(주주환원) 규모를 보여 줍니다.' },
  { id: 'category8', slug: 'calendar', name: '실적·배당 캘린더', icon: CalendarDays, view: EarningsCalendar,
    description: '유가증권시장의 잠정실적·배당 결정·정기보고서 공시를 달력에서 날짜별로 보고, 날짜를 누르면 원문 링크를 확인합니다.' },
  { id: 'category9', slug: 'rankings', name: '종목 순위', icon: ListOrdered, view: RankingsDashboard,
    description: '유가증권·코스닥의 상승률·하락률·거래대금·시가총액 상위 100개 종목을 날짜별로 보여 줍니다.' },
  { id: 'category7', slug: 'risk', name: '시장 연관성·리스크', icon: Network, view: RiskDashboard,
    description: '코스피가 해외 지수·환율·변동성·금리와 얼마나 같이 움직였는지(상관계수·베타)와 지표별 변동성·최대 낙폭을 기간별로 보여 줍니다.' },
]

export const DEFAULT_TAB_ID = 'category1'
export const tabById = (id: string) => TABS.find(tab => tab.id === id)
