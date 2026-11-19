// 재연결 때 실시간 캐시 다시 받기의 실제 요청 수 (plan.md FQA-14, T-198, BENCHMARK B-78)
// realtimeCache.ts는 재연결 때 ['recent'] 전체를 무효화한다. React Query는 기본(refetchType 'active')으로
// 지금 화면에 붙어 있는 쿼리만 바로 다시 받고, 나머지는 다음에 화면에 붙을 때 받는다. 그 동작을 실제 QueryClient로 잰다(네트워크 없음).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QueryClient, QueryObserver } from '@tanstack/react-query'

const SYMBOLS = Array.from({ length: 27 }, (_, index) => `S${index}`)

test('재연결 무효화는 화면에 붙은 실시간 카드만 바로 다시 받는다 (27개 동시 요청이 아님)', async () => {
  const client = new QueryClient()
  const fetched: string[] = []
  const options = (symbol: string) => ({
    queryKey: ['recent', symbol],
    queryFn: async () => { fetched.push(symbol); return { points: [] } },
    staleTime: Infinity,
    gcTime: Infinity,
  })
  // 한 번이라도 연 실시간 카드 27개의 캐시(realtimeCache가 tick을 붙여 둔 상태)
  for (const symbol of SYMBOLS) client.setQueryData(['recent', symbol], { points: [] })
  // 지금 보고 있는 탭의 실시간 카드 3개만 화면에 붙어 있음
  const active = SYMBOLS.slice(0, 3).map(symbol => new QueryObserver(client, options(symbol)))
  const unsubscribe = active.map(observer => observer.subscribe(() => undefined))
  assert.equal(fetched.length, 0, '캐시가 있고 staleTime이 무한이라 붙을 때 요청 없음')

  await client.invalidateQueries({ queryKey: ['recent'] })
  assert.deepEqual(fetched.sort(), ['S0', 'S1', 'S2'])
  // 무효화된 나머지는 다음에 화면에 붙을 때 다시 받는다(끊긴 동안 빠진 tick 보정은 그대로)
  assert.equal(client.getQueryState(['recent', 'S10'])?.isInvalidated, true)
  unsubscribe.forEach(stop => stop())
  client.clear()
})
