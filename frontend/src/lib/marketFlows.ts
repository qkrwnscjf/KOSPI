// 증시 자금 흐름 일별 통계 표시 (docs/Task_ORDER.md 11단계 B′ T-98, D-77)
// 테스트할 수 있도록 React와 분리한 순수 함수다. 다른 모듈을 import하지 않는다.
// 값은 원 단위(비중은 %)로 온다. 이름·단위는 원본(금융투자협회 종합통계) 화면과 대조해 확정한 서버 표를 그대로 쓴다.

export interface FlowValuePoint {
  time: number
  value: number
}

export interface FlowMetric {
  metric: string
  label: string
  unit: 'KRW' | 'percent'
  points: FlowValuePoint[]
}

export interface MarketFlowsData {
  latestTime: number | null
  metrics: FlowMetric[]
}

// 화면 묶음: 지표마다 작은 그래프 하나(크기가 크게 달라도 각자 축을 쓴다, 축 두 개는 쓰지 않음 D-65)
export const FLOW_GROUPS: { title: string; note: string; metrics: string[] }[] = [
  {
    title: '증시 대기 자금',
    note: '주식을 사려고 증권사에 맡겨 둔 돈과 단기 자금',
    metrics: ['capital.invrDpsgAmt', 'capital.onbdDrvPrdTrRcAdvAmt', 'capital.toCstRpchCndBndSlgBal'],
  },
  {
    title: '신용 공여 (빚투)',
    note: '증권사에서 빌려 주식을 산 금액',
    metrics: ['credit.crdTrFingWhl', 'credit.crdTrFingScrs', 'credit.crdTrFingKosdaq', 'credit.dpsgScrtMogFing', 'credit.sbscCapLn'],
  },
  {
    title: '미수금 · 반대매매',
    note: '외상으로 산 주식 대금과, 갚지 못해 강제로 판 금액',
    metrics: ['capital.brkTrdUcolMny', 'capital.brkTrdUcolMnyVsOppsTrdAmt', 'capital.ucolMnyVsOppsTrdRlImpt'],
  },
  {
    title: '신용거래대주',
    note: '주식을 빌려서 판(공매도) 금액',
    metrics: ['credit.crdTrLndrWhl', 'credit.crdTrLndrScrs', 'credit.crdTrLndrKosdaq'],
  },
]

const isPoint = (value: unknown): value is FlowValuePoint =>
  !!value && typeof value === 'object' &&
  Number.isFinite((value as FlowValuePoint).time) && Number.isFinite((value as FlowValuePoint).value)

// 서버 응답 형식 검사. 형식이 다르면 null
export function toMarketFlows(body: unknown): MarketFlowsData | null {
  if (!body || typeof body !== 'object') return null
  const { metrics, latestTime } = body as { metrics?: unknown; latestTime?: unknown }
  if (!Array.isArray(metrics)) return null
  const parsed: FlowMetric[] = []
  for (const item of metrics) {
    if (!item || typeof item !== 'object') continue
    const { metric, label, unit, points } = item as Record<string, unknown>
    if (typeof metric !== 'string' || typeof label !== 'string' || (unit !== 'KRW' && unit !== 'percent') || !Array.isArray(points)) continue
    parsed.push({ metric, label, unit, points: points.filter(isPoint).sort((a, b) => a.time - b.time) })
  }
  return { latestTime: typeof latestTime === 'number' && Number.isFinite(latestTime) ? latestTime : null, metrics: parsed }
}

// 금액: 1조 이상은 "89.9조원", 1억 이상은 "9,343억원", 그 아래는 "0.5억원"(0은 "0원")
export function formatWon(won: number) {
  if (!Number.isFinite(won)) return '—'
  const sign = won < 0 ? '−' : ''
  const abs = Math.abs(won)
  if (abs === 0) return '0원'
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(1)}조원`
  if (abs >= 1e8) return `${sign}${Math.round(abs / 1e8).toLocaleString('ko-KR')}억원`
  return `${sign}${(abs / 1e8).toFixed(1)}억원`
}

// 지표 값 표시 (비중은 %, 소수 둘째 자리까지)
export const formatFlowValue = (value: number, unit: FlowMetric['unit']) =>
  unit === 'percent' ? (Number.isFinite(value) ? `${Math.round(value * 100) / 100}%` : '—') : formatWon(value)

// 전 영업일 대비 증감 표시 (+/−, 비중은 %p)
export function formatFlowChange(change: number | null, unit: FlowMetric['unit']) {
  if (change === null || !Number.isFinite(change)) return '—'
  const sign = change > 0 ? '+' : change < 0 ? '−' : ''
  if (unit === 'percent') return `${sign}${Math.round(Math.abs(change) * 100) / 100}%p`
  return `${sign}${formatWon(Math.abs(change))}`
}

// ── 그래프 밖 표현 (D-78): 한 줄 요약 · 1개월 범위 막대 · 한 달 변화 순위 · 구성 비율 ──
// 비교 기준은 모두 "화면에 있는 최근 1개월" 안이다. 1년 데이터가 없으므로 역대 최고 같은 표현은 쓰지 않는다.

// 1개월 범위 안에서 마지막 값의 위치(0 = 최저, 1 = 최고)와 설명. 값이 모두 같으면 위치 없음
export function rangePosition(points: FlowValuePoint[]) {
  const latest = points[points.length - 1]
  if (!latest) return null
  const values = points.map(point => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max === min) return { min, max, latest: latest.value, position: null, text: '1개월 동안 변화 없음' }
  const position = (latest.value - min) / (max - min)
  const text = position >= 0.999 ? '1개월 중 최고' : position <= 0.001 ? '1개월 중 최저'
    : position >= 2 / 3 ? '1개월 범위의 높은 편' : position <= 1 / 3 ? '1개월 범위의 낮은 편' : '1개월 범위의 중간'
  return { min, max, latest: latest.value, position, text }
}

// 1개월 첫 값 대비 마지막 값. 비중(%)은 %p 변화만, 금액은 변화율도(첫 값이 0이면 변화율 없음)
export function monthChange(metric: FlowMetric) {
  const first = metric.points[0]
  const last = metric.points[metric.points.length - 1]
  if (!first || !last || first === last) return null
  const change = last.value - first.value
  const changePct = metric.unit === 'KRW' && first.value > 0 ? (change / first.value) * 100 : null
  return { from: first.time, to: last.time, change, changePct }
}

// 한 줄 요약 문장(규칙으로 만듦): "투자자예탁금 89.9조원 — 1개월 중 최고, 1개월 새 +3.2조원"
export function summaryLine(metric: FlowMetric) {
  const position = rangePosition(metric.points)
  if (!position) return null
  const month = monthChange(metric)
  const changeText = month ? `1개월 새 ${formatFlowChange(month.change, metric.unit)}` : '이전 값 없음'
  return { label: metric.label, value: formatFlowValue(position.latest, metric.unit), detail: `${position.text}, ${changeText}`, change: month?.change ?? null }
}

// 한 달 변화 순위: 금액 지표만 변화율 큰 순(증가 → 감소). 변화율을 낼 수 없는 지표(첫 값 0)는 뺀다
export function changeRanking(metrics: FlowMetric[]) {
  return metrics
    .map(metric => ({ metric, month: monthChange(metric) }))
    .filter((item): item is { metric: FlowMetric; month: NonNullable<ReturnType<typeof monthChange>> & { changePct: number } } =>
      item.metric.unit === 'KRW' && item.month !== null && item.month.changePct !== null)
    .sort((a, b) => b.month.changePct - a.month.changePct)
}

// 구성 비율: 유가증권·코스닥 마지막 값의 비중(%). 합계가 0 이하이면 없음
export function compositionShares(parts: { label: string; value: number }[]) {
  const total = parts.reduce((sum, part) => sum + (part.value > 0 ? part.value : 0), 0)
  if (total <= 0) return null
  return { total, shares: parts.map(part => ({ label: part.label, value: part.value, share: (Math.max(part.value, 0) / total) * 100 })) }
}

// 마지막 값과 바로 앞 영업일 대비 증감(점이 하나면 증감 없음)
export function latestWithChange(points: FlowValuePoint[]) {
  const latest = points[points.length - 1]
  const previous = points[points.length - 2]
  if (!latest) return null
  return { latest, change: previous ? latest.value - previous.value : null }
}
