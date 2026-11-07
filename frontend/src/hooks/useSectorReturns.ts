import { requestStatus } from '@/lib/api'
import { parseSectorReturns } from '@/lib/parsers'
import { STALE_MS } from '@/lib/queryClient'
import { useApiQuery } from '@/hooks/useApiQuery'
import type { SectorReturn } from '@/lib/sectors'

// 섹터 기간 수익률 (docs/Task_ORDER.md D-66): REST `/api/v1/market/sector-returns?range=`. 조회 계층 T-165
const EMPTY: SectorReturn[] = []

export function useSectorReturns(range: string) {
  const query = useApiQuery(['sector-returns', range], 'market/sector-returns', { range }, parseSectorReturns, { staleTime: STALE_MS.daily })
  return { data: query.data ?? EMPTY, status: requestStatus(query) }
}
