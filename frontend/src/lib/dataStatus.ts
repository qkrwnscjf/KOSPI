// 카드 데이터 상태 한 줄 (docs/Task_ORDER.md T-168, BENCHMARK B-70)
// 장 상태, 소스 지연, 마지막 수신 시각을 한 줄로 합치고, 장중에 값이 멈췄는지 판단한다.
// 테스트할 수 있도록 React와 분리한 순수 함수다. 다른 모듈을 import하지 않는다(`@/` 별칭 없음).

// 장이 열려 있는데 이보다 오래 새 값을 받지 못하면 "갱신 지연"으로 본다.
// 가장 드물게 갱신되는 지표(JPY/KRW, CNY/KRW)도 약 5분 간격이라(B-66 측정 기간 worker 지표) 넉넉히 15분으로 둔다
export const STALE_AFTER_MS = 15 * 60_000

// 지난 시간을 짧은 글로 (예전 ChartCard의 formatAge를 옮김, T-27)
export function formatAge(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}초 전`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  return `${Math.floor(hours / 24)}일 전`
}

export interface DataStatusInput {
  marketLabel: string | null // 장중·장 마감·휴장 등. 시장이 정해지지 않은 카드는 null
  marketOpen: boolean
  delayMinutes: number | null // 측정한 소스 지연(1분 미만이면 null)
  sourceTime: number | null // 소스가 준 시각
  receivedAt: number | null // worker 수집 시각. 없으면 소스 시각으로 대신한다
  now: number
}

export interface DataStatus {
  parts: string[]
  stale: boolean
}

export function dataStatus({ marketLabel, marketOpen, delayMinutes, sourceTime, receivedAt, now }: DataStatusInput): DataStatus {
  const parts: string[] = []
  if (marketLabel) parts.push(marketLabel)
  if (delayMinutes !== null) parts.push(`${delayMinutes}분 지연`)
  // 수신 시각이 있으면 "n초 전 수신"(소스 지연과 겹치지 않음). 없으면 예전처럼 소스 시각 기준
  let age: number | null = null
  if (receivedAt !== null) {
    parts.push(`${formatAge(now - receivedAt)} 수신`)
    age = now - receivedAt
  } else if (sourceTime !== null) {
    parts.push(`기준 ${formatAge(now - sourceTime)}`)
    age = now - sourceTime - (delayMinutes ?? 0) * 60_000
  }
  const stale = marketOpen && age !== null && age > STALE_AFTER_MS
  if (stale) parts.push('갱신 지연')
  return { parts, stale }
}
