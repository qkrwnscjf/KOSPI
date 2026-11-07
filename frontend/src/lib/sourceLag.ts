// 소스 지연 표시 (docs/Task_ORDER.md T-162)
// 카드의 "지연 N분" 배지를 고정값 대신 backend가 장중에 측정한 값으로 보여 준다.
// 테스트할 수 있도록 React와 분리한 순수 함수다. 다른 모듈을 import하지 않는다(`@/` 별칭 없음).

export interface SourceLag {
  lagSeconds: number
  samples: number
  measuredAt: number
}

// 1분보다 짧은 지연은 배지를 붙이지 않는다(수집 주기 5초와 소스 갱신 간격 수준이라 "지연 시세"가 아님)
export const DELAY_BADGE_MIN_SECONDS = 60

const isLag = (value: unknown): value is SourceLag => {
  if (!value || typeof value !== 'object') return false
  const { lagSeconds, samples, measuredAt } = value as Record<string, unknown>
  return [lagSeconds, samples, measuredAt].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
}

// REST 응답 검증: 형식이 맞는 지표만 남긴다
export function toSourceLags(body: unknown): Record<string, SourceLag> {
  const data = body && typeof body === 'object' ? (body as Record<string, unknown>).data : null
  if (!data || typeof data !== 'object') return {}
  return Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([, value]) => isLag(value))) as Record<string, SourceLag>
}

// 계산 카드(장단기 금리차)는 두 지표 중 더 늦은 쪽을 따른다
export function combineLags(a: SourceLag | undefined, b: SourceLag | undefined): SourceLag | undefined {
  if (!a || !b) return undefined
  return { lagSeconds: Math.max(a.lagSeconds, b.lagSeconds), samples: Math.min(a.samples, b.samples), measuredAt: Math.min(a.measuredAt, b.measuredAt) }
}

// 배지에 쓸 분 단위 값. 측정값이 없거나 1분 미만이면 null(배지 없음)
export function delayBadgeMinutes(lag: SourceLag | undefined): number | null {
  if (!lag || lag.lagSeconds < DELAY_BADGE_MIN_SECONDS) return null
  return Math.max(1, Math.round(lag.lagSeconds / 60))
}
