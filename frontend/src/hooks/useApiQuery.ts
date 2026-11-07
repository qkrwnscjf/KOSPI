import { useQuery, type QueryKey } from '@tanstack/react-query'
import { buildUrl, getJson, requestStatus, type RequestStatus } from '@/lib/api'
import { API_BASE } from '@/lib/queryClient'

// 모든 REST 조회가 거치는 훅 (docs/Task_ORDER.md T-165, D-92)
// 주소 구성(buildUrl), 시간 제한·취소(getJson + React Query 신호), 응답 검증(parse)을 한 번에 건다.
export interface ApiQueryOptions {
  enabled?: boolean
  staleTime?: number
  gcTime?: number
  refetchInterval?: number | false
}

export function useApiQuery<T>(
  queryKey: QueryKey,
  path: string,
  params: Record<string, string | null | undefined>,
  parse: (body: unknown) => T | null,
  options: ApiQueryOptions = {}
) {
  return useQuery({
    queryKey,
    queryFn: ({ signal }) => getJson(buildUrl(API_BASE, path, params), parse, { signal }),
    ...options,
  })
}

// 컴포넌트가 쓰던 형태({ data, status })로 바꾼다
export function toResult<T>(query: { data: T | undefined; isPending: boolean; isError: boolean }): { data: T | null; status: RequestStatus } {
  return { data: query.data ?? null, status: requestStatus(query) }
}
