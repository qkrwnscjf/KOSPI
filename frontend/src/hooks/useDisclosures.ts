import { useEffect, useMemo, useState } from 'react'
import { subscribeDisclosures } from '@/lib/marketSocket'
import { mergeDisclosures, type DisclosureItem } from '@/lib/disclosures'
import { requestStatus } from '@/lib/api'
import { parseCapitalEvents, parseDisclosurePage } from '@/lib/parsers'
import { STALE_MS } from '@/lib/queryClient'
import { toResult, useApiQuery } from '@/hooks/useApiQuery'

// 공시·자본 이벤트 데이터 (docs/Task_ORDER.md 12단계 T-78, 조회 계층 T-165)
// - 최근 공시: REST `/api/v1/disclosures/recent` + 공유 소켓의 새 공시(방 `disclosures:KOSPI`)
// - 자본 이벤트: REST `/api/v1/disclosures/capital-events`
export type { CapitalBucket, CapitalEvents, DisclosureScope } from '@/lib/parsers'

export function useRecentDisclosures(group: string) {
  const query = useApiQuery(['disclosures', 'recent', group], 'disclosures/recent', { group }, parseDisclosurePage, { staleTime: STALE_MS.disclosures })

  // 새 공시는 고른 분류에 맞는 것만 목록 위에 붙인다 (REST 응답보다 먼저 온 것도 합침)
  const [live, setLive] = useState<DisclosureItem[]>([])
  useEffect(() => {
    setLive([])
    return subscribeDisclosures(disclosure => {
      if (group !== 'all' && disclosure.group !== group) return
      setLive(previous => mergeDisclosures(previous, [disclosure]))
    })
  }, [group])

  const fetched = query.data?.items
  const items = useMemo(() => mergeDisclosures(fetched ?? [], live), [fetched, live])
  return { items, status: requestStatus(query), scope: query.data?.scope ?? null }
}

export const useCapitalEvents = (range: string) =>
  toResult(useApiQuery(['disclosures', 'capital-events', range], 'disclosures/capital-events', { range }, parseCapitalEvents, { staleTime: STALE_MS.daily }))
