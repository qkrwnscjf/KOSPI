import { useEffect, useState } from 'react'
import { toMarketFlows, type MarketFlowsData } from '@/lib/marketFlows'
import type { ChartStatus } from '@/hooks/useMarketData'

// 증시 자금 흐름 일별 통계 (docs/Task_ORDER.md 11단계 B′ T-98): REST `/api/v1/flows/market` (최근 1개월 고정)
const HISTORY_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1/market/history'
const MARKET_FLOWS_URL = HISTORY_URL.replace(/market\/history$/, 'flows/market')

export function useMarketFlows() {
  const [data, setData] = useState<MarketFlowsData | null>(null)
  const [status, setStatus] = useState<ChartStatus>('loading')

  useEffect(() => {
    let cancelled = false
    fetch(MARKET_FLOWS_URL)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(body => {
        if (cancelled) return
        const parsed = toMarketFlows(body)
        setData(parsed)
        setStatus(parsed ? 'loaded' : 'error')
      })
      .catch(err => {
        if (cancelled) return
        console.error('Failed to fetch market flows', err)
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { data, status }
}
