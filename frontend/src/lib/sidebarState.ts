// 사이드바 열기/접기 상태 저장 (docs/Task_ORDER.md T-199, D-95)
// 접힌 상태를 브라우저에 저장해 새로고침해도 유지한다. 테마 저장(theme.ts)과 같은 방식이다.
// 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 펼친 상태로 시작하고 저장만 건너뛴다.
// 테스트할 수 있도록 저장소를 인자로 받는 순수 함수다(`@/` 별칭 없음).

export const SIDEBAR_STORAGE_KEY = 'kospi-sidebar-collapsed'

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>

export function readCollapsed(store: KeyValueStore | undefined): boolean {
  try {
    return store?.getItem(SIDEBAR_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeCollapsed(store: KeyValueStore | undefined, collapsed: boolean): void {
  try {
    store?.setItem(SIDEBAR_STORAGE_KEY, collapsed ? 'true' : 'false')
  } catch {
    // 저장할 수 없어도 화면 전환은 동작한다
  }
}
