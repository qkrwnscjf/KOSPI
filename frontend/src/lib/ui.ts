// 화면 공통 상수·상태 문구 (plan.md FQA-08 · 16, docs/Task_ORDER.md T-221 · T-222, BENCHMARK B-93 · B-94)
// 예전에는 카드 틀 클래스가 8개 파일 11곳, 상태 문구가 9개 파일 18곳에 복사되어 있어 바꿀 때 여러 파일을 고쳐야 했다.
// 테스트할 수 있도록 React와 분리했다. 다른 모듈을 import하지 않는다(`@/` 별칭 없음).

// 카드 틀: 테두리·배경·둥근 모서리·호버 빛(card-neon). 여백·배치는 쓰는 곳에서 붙인다
export const CARD_FRAME = 'card-neon rounded-xl border border-line bg-surface'

export const STATUS_TEXT = {
  loading: '불러오는 중',
  error: '데이터를 불러오지 못했습니다',
  notReady: '데이터 준비 중',
  empty: '표시할 데이터가 없습니다',
} as const

export type LoadState = 'loading' | 'loaded' | 'not_ready' | 'error'

// 데이터 대신 보여 줄 문구. 데이터가 있으면 null
// - 수집 보류 중인 지표(not_ready)와 오류는 데이터 여부와 상관없이 알린다
// - 불러오는 중이어도 이미 보여 줄 데이터가 있으면(이전 값) 그대로 보여 준다
export function statusText(status: LoadState, empty: boolean, emptyText: string = STATUS_TEXT.empty): string | null {
  if (status === 'not_ready') return STATUS_TEXT.notReady
  if (status === 'error') return STATUS_TEXT.error
  if (!empty) return null
  if (status === 'loading') return STATUS_TEXT.loading
  return emptyText
}

export const isLoadingText = (message: string | null) => message === STATUS_TEXT.loading
