import { getConnectionStatus, subscribeStatus, subscribeTicks } from '@/lib/marketSocket'
import { appendToSeries } from '@/lib/chartPoints'
import type { HistoryResult } from '@/lib/parsers'
import { queryClient } from '@/lib/queryClient'

// 실시간 그래프 캐시를 소켓으로 계속 채운다 (docs/Task_ORDER.md T-165 보완, BENCHMARK B-68)
// 이전에는 탭을 떠나면 소켓 구독이 끊겨, 다시 열 때 그 사이 값이 빠지지 않도록 최근 tick을 다시 받아야 했다(요청 −2.2%에 그친 원인).
// - 첫 화면(최근 tick 50개)을 한 번 받은 지표는 탭을 떠나도 구독을 유지하고, 들어오는 tick을 캐시에 붙인다.
//   소켓은 하나를 함께 쓰므로 연결 수는 늘지 않는다. 구독하는 지표는 한 번이라도 연 실시간 카드뿐이다(최대 27개).
// - 연결이 끊겼다 다시 붙으면 그 사이 tick이 빠졌을 수 있어 실시간 캐시를 모두 새로 받게 한다.

export const recentKey = (symbol: string) => ['recent', symbol] as const

const tracked = new Set<string>()
let watchingConnection = false
let wasConnected = getConnectionStatus() === 'connected'

function watchReconnect() {
  if (watchingConnection) return
  watchingConnection = true
  subscribeStatus(() => {
    const connected = getConnectionStatus() === 'connected'
    if (connected && !wasConnected) void queryClient.invalidateQueries({ queryKey: ['recent'] })
    wasConnected = connected
  })
}

// 첫 화면을 받은 뒤에 부른다. 같은 지표는 한 번만 구독한다(앱이 열려 있는 동안 유지)
export function trackRealtime(symbol: string) {
  if (tracked.has(symbol)) return
  tracked.add(symbol)
  watchReconnect()
  subscribeTicks(symbol, tick => {
    queryClient.setQueryData<HistoryResult>(recentKey(symbol), previous => appendToSeries(previous, { time: tick.timestamp, value: tick.price }))
  })
}
