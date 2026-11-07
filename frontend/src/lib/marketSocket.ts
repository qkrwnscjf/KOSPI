import { io, Socket } from 'socket.io-client'
import type { MarketState } from '@/lib/marketHours'

// 앱 전체가 함께 쓰는 WebSocket 연결 1개 (docs/Task_ORDER.md T-24, P-12)
// 이전에는 차트 카드마다 소켓을 따로 열어서, 브라우저 1개가 카드 수만큼 연결을 만들었다.
// 카드는 심볼별로 구독만 하고, 같은 심볼을 여러 곳에서 구독해도 서버에는 한 번만 요청한다.

export interface TickData {
  symbol: string
  category: string
  price: number
  changeRate: number
  changePrice?: number
  timestamp: number // 소스 기준 시각 (ms)
  volume?: number
  marketState?: MarketState // 소스의 장 상태 (T-56)
}

type TickListener = (tick: TickData) => void

// DART 공시 (docs/Task_ORDER.md 12단계). 서버가 보내는 필드만 있다 (개인 이름 없음)
export interface DisclosureData {
  rceptNo: string
  rceptDate: string
  stockCode: string
  corpName: string
  reportName: string
  group: string
  kind: string
  isCorrection: boolean
  amount: number | null
}

type DisclosureListener = (disclosure: DisclosureData) => void

const DISCLOSURE_ROOM = 'disclosures:KOSPI'
const disclosureListeners = new Set<DisclosureListener>()

// 연결 상태 (docs/Task_ORDER.md T-33): 화면의 "실시간" 표시를 실제 연결 상태로 보여 주기 위함
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001'

const listeners = new Map<string, Set<TickListener>>()
const latestTicks = new Map<string, TickData>()
let socket: Socket | undefined

// 연결 상태와 마지막 수신 시각. React의 useSyncExternalStore로 읽는다.
let connectionStatus: ConnectionStatus = 'connecting'
let lastReceivedAt: number | null = null
const statusListeners = new Set<() => void>()
const notifyStatus = () => statusListeners.forEach(listener => listener())

function getSocket() {
  if (socket) return socket
  const created = io(SOCKET_URL)

  // 처음 연결하거나 다시 연결되면, 지금 구독 중인 심볼을 모두 다시 구독한다 (서버의 방 정보는 연결마다 새로 시작).
  created.on('connect', () => {
    connectionStatus = 'connected'
    notifyStatus()
    for (const symbol of listeners.keys()) {
      created.emit('subscribe_market', symbol)
    }
    if (disclosureListeners.size > 0) created.emit('subscribe_market', DISCLOSURE_ROOM)
  })
  created.on('disconnect', () => {
    connectionStatus = 'disconnected'
    notifyStatus()
  })
  created.on('connect_error', () => {
    connectionStatus = 'disconnected'
    notifyStatus()
  })

  created.on('tick', (tick: TickData) => {
    // 구독 직후 받는 캐시값이 이미 받은 실시간 값보다 오래된 경우가 있어서, 시각이 뒤로 가는 값은 버린다.
    const previous = latestTicks.get(tick.symbol)
    if (previous && tick.timestamp < previous.timestamp) return
    latestTicks.set(tick.symbol, tick)
    lastReceivedAt = Date.now()
    notifyStatus()
    listeners.get(tick.symbol)?.forEach(listener => listener(tick))
  })

  created.on('disclosure', (disclosure: DisclosureData) => {
    lastReceivedAt = Date.now()
    notifyStatus()
    disclosureListeners.forEach(listener => listener(disclosure))
  })

  socket = created
  return created
}

// 새 공시를 구독한다 (같은 소켓, 방 `disclosures:KOSPI`). 첫 화면 목록은 REST로 받는다.
export function subscribeDisclosures(listener: DisclosureListener): () => void {
  const current = getSocket()
  if (disclosureListeners.size === 0 && current.connected) current.emit('subscribe_market', DISCLOSURE_ROOM)
  disclosureListeners.add(listener)
  return () => {
    disclosureListeners.delete(listener)
    if (disclosureListeners.size === 0 && current.connected) current.emit('unsubscribe_market', DISCLOSURE_ROOM)
  }
}

export function subscribeStatus(listener: () => void) {
  getSocket()
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

export const getConnectionStatus = () => connectionStatus
export const getLastReceivedAt = () => lastReceivedAt

// 심볼의 tick을 구독하고, 구독 해제 함수를 돌려준다. 이미 받은 최신값이 있으면 바로 한 번 전달한다.
export function subscribeTicks(symbol: string, listener: TickListener): () => void {
  const current = getSocket()

  let symbolListeners = listeners.get(symbol)
  if (!symbolListeners) {
    symbolListeners = new Set()
    listeners.set(symbol, symbolListeners)
    if (current.connected) current.emit('subscribe_market', symbol)
  }
  symbolListeners.add(listener)

  const cached = latestTicks.get(symbol)
  if (cached) listener(cached)

  return () => {
    const set = listeners.get(symbol)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) {
      listeners.delete(symbol)
      if (current.connected) current.emit('unsubscribe_market', symbol)
    }
  }
}
