// 처음 화면의 테마 정하기 (plan.md FQA-12, T-203)
// 사용자가 고른 테마가 저장돼 있으면 그것을, 없으면 운영체제의 다크 모드 설정을 따른다(예전에는 항상 라이트로 시작).
// index.html의 인라인 스크립트도 같은 규칙이다(화면을 그리기 전에 적용). 테스트할 수 있도록 순수 함수로 둔다(`@/` 별칭 없음).
export type Theme = 'light' | 'dark'

export function initialTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === 'dark' || stored === 'light') return stored
  return prefersDark ? 'dark' : 'light'
}
