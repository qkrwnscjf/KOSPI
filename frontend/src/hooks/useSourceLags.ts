import { toSourceLags, type SourceLag } from '@/lib/sourceLag'
import { useApiQuery } from '@/hooks/useApiQuery'

// 소스 지연 측정값 (docs/Task_ORDER.md T-162): REST `/api/v1/market/source-lags`
// 카드 수십 개가 같은 값을 쓰지만 React Query가 요청을 하나로 합친다(T-165). 측정값은 1분에 한 번 바뀌어 5분마다 다시 받는다.
const REFRESH_MS = 5 * 60_000
const EMPTY: Record<string, SourceLag> = {}

export function useSourceLags() {
  const query = useApiQuery(['source-lags'], 'market/source-lags', {}, toSourceLags, { staleTime: REFRESH_MS, refetchInterval: REFRESH_MS })
  return query.data ?? EMPTY
}
