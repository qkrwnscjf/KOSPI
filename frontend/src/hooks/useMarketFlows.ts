import { toMarketFlows } from '@/lib/marketFlows'
import { STALE_MS } from '@/lib/queryClient'
import { toResult, useApiQuery } from '@/hooks/useApiQuery'

// 증시 자금 흐름 일별 통계 (docs/Task_ORDER.md 11단계 B′ T-98): REST `/api/v1/flows/market` (최근 1개월 고정). 조회 계층 T-165
export const useMarketFlows = () => toResult(useApiQuery(['flows', 'market'], 'flows/market', {}, toMarketFlows, { staleTime: STALE_MS.flows }))
