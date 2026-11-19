// 대화 상자 안 포커스 순환 (plan.md FQA-11, T-197)
// 설정 창은 화면 전체를 덮는데(aria-modal) Tab을 누르면 포커스가 뒤쪽 화면으로 빠져나갔다.
// 마지막 요소에서 Tab이면 처음으로, 처음(또는 창 자체)에서 Shift+Tab이면 마지막으로 보낸다. 그 밖에는 브라우저에 맡긴다(null).
// 테스트할 수 있도록 React·DOM과 분리한 순수 함수다(`@/` 별칭 없음).

export function nextFocusIndex(current: number, count: number, shift: boolean): number | null {
  if (count === 0) return null
  if (current < 0) return shift ? count - 1 : 0
  if (shift && current === 0) return count - 1
  if (!shift && current === count - 1) return 0
  return null
}

export const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
