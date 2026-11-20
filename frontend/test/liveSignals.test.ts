// 화면 정확성 시험 (plan.md QA-32 / P4-2, docs/Task_ORDER.md T-215, BENCHMARK B-87)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { createReconnectDetector, isNewerTick, RECONNECT_REFETCH_KEYS } from '../src/lib/liveSignals.ts'
import { formatClock, formatDate } from '../src/lib/format.ts'
import { DATASET_LABELS, SERVICE_LABELS } from '../src/lib/pipeline.ts'

test('① 구독 때 받은 캐시값·같은·옛 시각 tick은 "마지막 수신"을 바꾸지 않고, 더 새로운 시각만 바꾼다', () => {
  assert.equal(isNewerTick(undefined, { timestamp: 1_000 }), false, '지표의 첫 tick = 구독 때 받은 캐시값')
  assert.equal(isNewerTick({ timestamp: 1_000 }, { timestamp: 1_000 }), false, '다시 구독할 때 받은 같은 값')
  assert.equal(isNewerTick({ timestamp: 1_000 }, { timestamp: 900 }), false)
  assert.equal(isNewerTick({ timestamp: 1_000 }, { timestamp: 1_001 }), true)
})

test('② 시각·날짜는 실행 환경 시간대와 무관하게 서울 시간', () => {
  // 빌드 컨테이너는 UTC라, 브라우저 시간대를 쓰던 예전 함수면 07:30:05로 나와 실패한다
  assert.equal(formatClock(Date.parse('2026-11-19T07:30:05Z')), '16:30:05')
  assert.equal(formatClock(Date.parse('2026-11-19T07:30:05Z'), false), '16:30')
  assert.equal(formatClock(Date.parse('2026-11-19T15:00:00Z')), '00:00:00', '자정은 24가 아니라 00')
  // 일별 값 시각(15:30 KST) → 그날 날짜
  assert.equal(formatDate(Date.parse('2026-11-19T06:30:00Z')), '11/19')
  assert.equal(formatDate(Date.parse('2026-11-19T06:30:00Z'), true), '2026/11/19')
  // 서울에서는 이미 다음 날
  assert.equal(formatDate(Date.parse('2026-12-31T15:30:00Z'), true), '2027/1/1')
})

test('③ 재연결 감지: 첫 연결은 재연결이 아니고, 끊긴 뒤 다시 연결될 때만 true', () => {
  const fromConnecting = createReconnectDetector(false)
  assert.equal(fromConnecting(true), false, '처음 연결')
  assert.equal(fromConnecting(true), false, '연결 유지')
  assert.equal(fromConnecting(false), false, '끊김')
  assert.equal(fromConnecting(true), true, '다시 연결')
  assert.equal(fromConnecting(true), false)

  const neverConnected = createReconnectDetector(false)
  assert.equal(neverConnected(false), false, '연결 실패(connect_error)')
  assert.equal(neverConnected(true), false, '실패 뒤 첫 연결도 재연결이 아님')

  const fromConnected = createReconnectDetector(true)
  assert.equal(fromConnected(false), false)
  assert.equal(fromConnected(true), true)
})

test('④ 재연결 때 최근 공시도 다시 받는다 (실제 QueryClient, 네트워크 없음)', async () => {
  assert.ok(RECONNECT_REFETCH_KEYS.some(key => key.join('/') === 'disclosures/recent'))
  assert.ok(RECONNECT_REFETCH_KEYS.some(key => key.join('/') === 'recent'))
  const client = new QueryClient()
  const fetched: string[] = []
  const observe = (queryKey: string[]) => new QueryObserver(client, {
    queryKey,
    queryFn: async () => { fetched.push(queryKey.join('/')); return [] },
    staleTime: Infinity,
  }).subscribe(() => undefined)
  const stops = [observe(['disclosures', 'recent', 'all']), observe(['disclosures', 'capital-events', '1주'])]
  await new Promise(resolve => setTimeout(resolve, 0))
  fetched.length = 0
  for (const queryKey of RECONNECT_REFETCH_KEYS) await client.invalidateQueries({ queryKey: [...queryKey] })
  assert.deepEqual(fetched, ['disclosures/recent/all'], '최근 공시만 다시 받고 자본 이벤트(일별)는 그대로')
  stops.forEach(stop => stop())
  client.clear()
})

test('⑤ 설정 화면 라벨: Prometheus 수집 대상 7개, 데이터셋 6개 모두', () => {
  for (const job of ['worker', 'backend', 'db-sink', 'krx-collector', 'disclosure-collector', 'market-stats-collector', 'kafka-exporter']) {
    assert.ok(SERVICE_LABELS[job], job)
  }
  for (const dataset of ['market_ticks', 'index_daily', 'market_breadth', 'disclosures', 'stock_rankings', 'market_flows']) {
    assert.ok(DATASET_LABELS[dataset], dataset)
  }
})
