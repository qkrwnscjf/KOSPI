// 프론트 데이터 요청 공통 계층 (docs/Task_ORDER.md T-165, D-92)
// - 주소는 한 곳에서 만든다. 이전에는 훅 7곳이 VITE_API_URL(그래프 API 전체 주소)을 정규식으로 바꿔 자기 주소를 만들었다.
// - 모든 요청에 시간 제한과 취소를 건다. 화면을 벗어나면 React Query가 넘겨주는 신호로 요청을 실제로 끊는다.
// - 응답은 검증 함수를 통과한 값만 쓴다. 통과하지 못하면 오류로 본다.
// 테스트할 수 있도록 React·환경변수와 분리한 순수 함수다. 다른 모듈을 import하지 않는다(`@/` 별칭 없음).

export const DEFAULT_API_BASE = 'http://localhost:3001/api/v1'
export const DEFAULT_TIMEOUT_MS = 10_000

// VITE_API_URL은 예전 형식(…/api/v1/market/history)과 기본 주소(…/api/v1)를 모두 받는다
export function resolveApiBase(raw: string | undefined): string {
  const value = (raw ?? '').trim()
  if (!value) return DEFAULT_API_BASE
  return value.replace(/\/+$/, '').replace(/\/market\/history$/, '')
}

// 쿼리 값은 모두 인코딩한다. 값이 없는(null·undefined) 항목은 넣지 않는다
export function buildUrl(base: string, path: string, params: Record<string, string | null | undefined> = {}): string {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  return `${base}/${path.replace(/^\/+/, '')}${query ? `?${query}` : ''}`
}

export type ApiErrorKind = 'timeout' | 'aborted' | 'network' | 'http' | 'invalid'

export class ApiError extends Error {
  kind: ApiErrorKind
  status: number | undefined
  constructor(kind: ApiErrorKind, status?: number) {
    super(status === undefined ? kind : `${kind} ${status}`)
    this.kind = kind
    this.status = status
  }
}

export interface GetJsonOptions {
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: (input: string, init: { signal: AbortSignal }) => Promise<Response>
}

// JSON을 받아 검증 함수로 바꾼다. 실패는 종류만 담은 ApiError로 던진다(응답 본문은 담지 않음)
export async function getJson<T>(url: string, parse: (body: unknown) => T | null, options: GetJsonOptions = {}): Promise<T> {
  const { signal, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = (input, init) => fetch(input, init) } = options
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let response: Response
    try {
      response = await fetchImpl(url, { signal: controller.signal })
    } catch {
      throw new ApiError(timedOut ? 'timeout' : signal?.aborted ? 'aborted' : 'network')
    }
    if (!response.ok) throw new ApiError('http', response.status)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new ApiError(timedOut ? 'timeout' : 'invalid')
    }
    const parsed = parse(body)
    if (parsed === null) throw new ApiError('invalid')
    return parsed
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

// 화면 상태: loading 불러오는 중, loaded 받음(0개일 수 있음), not_ready 수집 보류 중인 지표, error 실패
export type RequestStatus = 'loading' | 'loaded' | 'not_ready' | 'error'

export function requestStatus(query: { isPending: boolean; isError: boolean }, notReady = false): RequestStatus {
  if (query.isError) return 'error'
  if (query.isPending) return 'loading'
  return notReady ? 'not_ready' : 'loaded'
}
