import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { createSharedSource } from './sharedSource'

// 라이트·다크 전환 (docs/Task_ORDER.md T-54, D-35)
// 기본은 라이트. 선택은 브라우저에 저장하고, 다음 접속 때 index.html의 인라인 스크립트가 화면을 그리기 전에 적용한다.

export type { Theme } from './themeChoice'
import type { Theme } from './themeChoice'

const STORAGE_KEY = 'kospi-theme'

const currentTheme = (): Theme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light')

// 테마 바뀜 감시 (plan.md FQA-13, T-196): 감시자(MutationObserver) 하나를 모든 컴포넌트가 함께 쓴다.
// 예전에는 useTokenColors를 쓰는 컴포넌트마다 감시자를 만들었다(증시 자금 흐름 탭의 카드 14장 등)
let themeVersion = 0
const themeSource = createSharedSource(notify => {
  const observer = new MutationObserver(() => {
    themeVersion += 1
    notify()
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
})
const getThemeVersion = () => themeVersion

// CSS 색 토큰을 실제 색 문자열로 읽는다 (예: 'up' → 'rgb(21 128 61)'). 막대별 색처럼 currentColor로 칠할 수 없는 SVG에 쓴다.
// 테마(<html class="dark">)가 바뀌면 다시 읽는다.
export function useTokenColors<T extends string>(names: readonly T[]): Record<T, string> {
  const version = useSyncExternalStore(themeSource.subscribe, getThemeVersion)
  return useMemo(
    () => Object.fromEntries(
      names.map(name => [name, `rgb(${getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim()})`])
    ) as Record<T, string>,
    // names는 호출하는 곳에서 고정된 배열로 넘긴다. 테마가 바뀔 때(version)만 다시 읽는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  )
}

// 테마 상태는 앱에 하나만 둔다 (plan.md FQA-12 · QA-32, T-203).
// 예전에는 토글 버튼마다(모바일·데스크톱 2개) 상태를 따로 가져, 한쪽에서 바꾸면 다른 쪽 버튼의 표시·다음 동작이 어긋났다.
// 지금 테마는 <html class="dark">를 그대로 읽고(themeSource가 바뀜을 알림), 바꿀 때만 저장한다.
// 저장된 선택이 없으면 처음 화면은 운영체제 설정을 따른다(index.html, themeChoice.ts)
export function useTheme() {
  useSyncExternalStore(themeSource.subscribe, getThemeVersion)
  const theme = currentTheme()
  const toggle = useCallback(() => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark'
    document.documentElement.classList.toggle('dark', next === 'dark')
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // 저장할 수 없는 환경(사생활 보호 모드 등)에서도 화면 전환은 동작한다.
    }
  }, [])
  return { theme, toggle }
}
