import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { getConnectionStatus, getLastReceivedAt, subscribeStatus, subscribeTicks, type TickData } from '@/lib/marketSocket'
import { appendPoint, mergePoints, type ChartPoint } from '@/lib/chartPoints'
import { spreadValue } from '@/lib/spread'
import { requestStatus, type RequestStatus } from '@/lib/api'
import { parseHistory } from '@/lib/parsers'
import { useApiQuery } from '@/hooks/useApiQuery'
import { recentKey, trackRealtime } from '@/hooks/realtimeCache'

export type { ChartPoint }

// 실시간 연결 상태와 마지막 데이터 수신 시각 (T-33). 공유 소켓 1개의 상태다.
export const useConnectionStatus = () => useSyncExternalStore(subscribeStatus, getConnectionStatus)
export const useLastReceivedAt = () => useSyncExternalStore(subscribeStatus, getLastReceivedAt)

// 화면 상태. 공통 정의는 lib/api.ts (T-165). 기존 import 경로를 위해 이름을 그대로 둔다
export type ChartStatus = RequestStatus

const REALTIME = '실시간'

// 기간별 캐시 유지·자동 갱신 (T-165, D-92). 서버 캐시(30초)보다 짧게 두지 않는다
// - 1일(5분 봉): 장중 5분마다 새 칸이 생겨 2분마다 다시 받는다
// - 1주(1시간 봉): 10분마다
// - 1개월 ~ 1년(1일 봉): 하루 1번 바뀌어 자동 갱신 없이 30분 동안 캐시를 쓴다
const HISTORY_CACHE: Record<string, { staleTime: number; refetchInterval: number | false }> = {
  '1일': { staleTime: 60_000, refetchInterval: 2 * 60_000 },
  '1주': { staleTime: 5 * 60_000, refetchInterval: 10 * 60_000 },
}
const DAILY_CACHE = { staleTime: 30 * 60_000, refetchInterval: false as const }
// 실시간 그래프의 첫 화면(최근 tick 50개)은 한 번만 받는다. 그 뒤로는 탭을 떠나 있어도 소켓이 캐시에 tick을 계속 붙이므로(realtimeCache.ts)
// 다시 열 때 새로 받지 않는다. 캐시를 지우지 않아야 붙여 온 값이 남는다. 연결이 끊겼다 붙으면 realtimeCache가 새로 받게 한다
const REALTIME_CACHE = { staleTime: Infinity, gcTime: Infinity, refetchInterval: false as const }

// 심볼의 최신 tick만 받는다 (Header의 현재가 등). 공유 소켓을 쓰므로 연결이 늘지 않는다 (T-24).
export function useLatestTick(symbol: string, enabled = true) {
  const [latest, setLatest] = useState<TickData | null>(null)
  useEffect(() => {
    if (!enabled) return
    return subscribeTicks(symbol, tick => setLatest(tick))
  }, [symbol, enabled])
  return latest
}

// 두 지표의 차이를 보여 주는 카드의 현재값 (T-107). 두 지표를 각각 구독하고 화면에서 계산한다(계산 지표의 구독 방은 없음).
export function useSpreadTick(symbol: string, spread: { long: string; short: string } | undefined, enabled: boolean): TickData | null {
  const long = useLatestTick(spread?.long ?? '', enabled && spread !== undefined)
  const short = useLatestTick(spread?.short ?? '', enabled && spread !== undefined)
  if (!spread || !long || !short) return null
  const value = spreadValue(long, short)
  const tick: TickData = { symbol, category: long.category, changeRate: 0, price: value.price, timestamp: value.timestamp }
  if (value.changePrice !== undefined) tick.changePrice = value.changePrice
  if (long.marketState !== undefined) tick.marketState = long.marketState
  return tick
}

// live: false이면 이 심볼의 실시간 tick을 구독하지 않는다(계산 지표처럼 구독 방이 없는 경우, T-107)
export function useMarketData(symbol: string, timeframe: string, ready: boolean, live = true) {
  // 현재가와 기준 시각은 타임프레임과 상관없이 실시간 값으로 표시한다 (소켓 1개를 공유하므로 추가 연결이 없음, T-24).
  const latest = useLatestTick(symbol, ready && live)
  const isRealtime = timeframe === REALTIME

  // 실시간: DB의 최근 tick으로 첫 화면을 채운다 (T-25). 나머지 기간: 집계 그래프 (T-20). 기간마다 캐시가 따로라 섞이지 않는다 (T-27, P-13)
  const query = useApiQuery(
    isRealtime ? recentKey(symbol) : ['history', symbol, timeframe],
    isRealtime ? 'market/recent' : 'market/history',
    isRealtime ? { ticker: symbol } : { ticker: symbol, timeframe },
    parseHistory,
    { enabled: ready, ...(isRealtime ? REALTIME_CACHE : HISTORY_CACHE[timeframe] ?? DAILY_CACHE) }
  )

  // 첫 화면을 받으면 이 지표의 tick을 캐시에 계속 붙인다(탭을 떠나도 유지)
  const seeded = isRealtime && query.isSuccess
  useEffect(() => {
    if (ready && seeded) trackRealtime(symbol)
  }, [ready, seeded, symbol])

  // 첫 응답보다 먼저 온 tick도 화면에 보이도록 카드가 열려 있는 동안 따로 모아 합친다(같은 시각은 하나로)
  const [livePoints, setLivePoints] = useState<ChartPoint[]>([])
  useEffect(() => {
    setLivePoints([])
    if (!ready || !isRealtime) return
    return subscribeTicks(symbol, tick => setLivePoints(previous => appendPoint(previous, { time: tick.timestamp, value: tick.price })))
  }, [symbol, isRealtime, ready])

  const fetched = query.data?.points
  const chartData = useMemo(() => {
    if (!ready) return []
    return isRealtime ? mergePoints(fetched ?? [], livePoints) : fetched ?? []
  }, [ready, isRealtime, fetched, livePoints])

  const status: ChartStatus = ready ? requestStatus(query, query.data?.notReady ?? false) : 'not_ready'
  return { latest, chartData, status }
}
