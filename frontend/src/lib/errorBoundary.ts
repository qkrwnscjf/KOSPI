// 오류 경계 문구 (plan.md FQA-07, T-200)
// 테스트할 수 있도록 React와 분리한 순수 함수다(`@/` 별칭 없음).
export type BoundaryScope = 'tab' | 'card'

export function fallbackText(scope: BoundaryScope, label: string): string {
  return scope === 'tab'
    ? `${label} 화면을 그리는 중 오류가 났습니다. 다른 탭은 그대로 쓸 수 있습니다.`
    : `${label} 카드를 그리지 못했습니다.`
}
