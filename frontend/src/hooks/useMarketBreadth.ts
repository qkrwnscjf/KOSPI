import { parseBreadth } from '@/lib/parsers'
import { STALE_MS } from '@/lib/queryClient'
import { toResult, useApiQuery } from '@/hooks/useApiQuery'

// 시장 폭·거래대금 (docs/Task_ORDER.md T-106): REST `/api/v1/market/breadth?range=`. 조회 계층 T-165
export type { BreadthData } from '@/lib/parsers'

export const useMarketBreadth = (range: string) => toResult(useApiQuery(['breadth', range], 'market/breadth', { range }, parseBreadth, { staleTime: STALE_MS.daily }))
