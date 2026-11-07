import { toMarketRisk } from '@/lib/risk'
import { STALE_MS } from '@/lib/queryClient'
import { toResult, useApiQuery } from '@/hooks/useApiQuery'

// 시장 연관성·리스크 (docs/Task_ORDER.md T-110): REST `/api/v1/market/risk?range=`. 조회 계층 T-165
export const useMarketRisk = (range: string) => toResult(useApiQuery(['risk', range], 'market/risk', { range }, toMarketRisk, { staleTime: STALE_MS.daily }))
