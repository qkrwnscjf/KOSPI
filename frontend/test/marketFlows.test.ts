// 증시 자금 흐름 일별 통계 표시 테스트 (11단계 B′ T-98)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changeRanking, compositionShares, FLOW_GROUPS, formatFlowChange, formatFlowValue, formatWon, latestWithChange, monthChange, rangePosition, summaryLine, toMarketFlows, type FlowMetric } from '../src/lib/marketFlows.ts'

const metric = (key: string, values: number[], unit: FlowMetric['unit'] = 'KRW'): FlowMetric =>
  ({ metric: key, label: key, unit, points: values.map((value, index) => ({ time: index + 1, value })) })

test('rangePosition: 1개월 범위 안 위치와 설명, 값이 모두 같으면 위치 없음', () => {
  assert.equal(rangePosition([{ time: 1, value: 10 }, { time: 2, value: 20 }])?.text, '1개월 중 최고')
  assert.equal(rangePosition([{ time: 1, value: 20 }, { time: 2, value: 10 }])?.text, '1개월 중 최저')
  assert.equal(rangePosition([{ time: 1, value: 0 }, { time: 2, value: 10 }, { time: 3, value: 5 }])?.text, '1개월 범위의 중간')
  assert.equal(rangePosition([{ time: 1, value: 0 }, { time: 2, value: 10 }, { time: 3, value: 8 }])?.text, '1개월 범위의 높은 편')
  assert.equal(rangePosition([{ time: 1, value: 3 }, { time: 2, value: 3 }])?.position, null)
  assert.equal(rangePosition([]), null)
})

test('monthChange · summaryLine: 첫 값 대비, 비중은 %p만, 첫 값 0이면 변화율 없음', () => {
  assert.deepEqual(monthChange(metric('a', [100, 150, 110])), { from: 1, to: 3, change: 10, changePct: 10 })
  assert.equal(monthChange(metric('p', [0.5, 0.7], 'percent'))?.changePct, null)
  assert.equal(monthChange(metric('z', [0, 5]))?.changePct, null)
  assert.equal(monthChange(metric('one', [5])), null)
  assert.deepEqual(summaryLine({ ...metric('d', [86e12, 89.9e12]), label: '투자자예탁금' }),
    { label: '투자자예탁금', value: '89.9조원', detail: '1개월 중 최고, 1개월 새 +3.9조원', change: 3.9e12 })
})

test('changeRanking: 금액 지표만 변화율 큰 순, 비중·첫 값 0은 뺀다', () => {
  const ranked = changeRanking([metric('down', [100, 90]), metric('up', [100, 120]), metric('pct', [1, 2], 'percent'), metric('zero', [0, 3])])
  assert.deepEqual(ranked.map(item => item.metric.metric), ['up', 'down'])
})

test('compositionShares: 비중 합 100, 합계 0이면 없음', () => {
  const result = compositionShares([{ label: '유가증권', value: 75 }, { label: '코스닥', value: 25 }])
  assert.deepEqual(result?.shares.map(part => part.share), [75, 25])
  assert.equal(compositionShares([{ label: 'a', value: 0 }]), null)
})

test('formatWon: 조원·억원, 1억 미만은 소수 억원, 음수는 −', () => {
  assert.equal(formatWon(89_862_621_161_859), '89.9조원')
  assert.equal(formatWon(934_276_923_456), '9,343억원')
  assert.equal(formatWon(2_653_139_033), '27억원')
  assert.equal(formatWon(50_000_000), '0.5억원')
  assert.equal(formatWon(0), '0원')
  assert.equal(formatWon(-1_500_000_000_000), '−1.5조원')
  assert.equal(formatWon(Number.NaN), '—')
})

test('formatFlowValue · formatFlowChange: 비중은 %·%p, 금액은 부호 + 금액', () => {
  assert.equal(formatFlowValue(0.7, 'percent'), '0.7%')
  assert.equal(formatFlowChange(0.15, 'percent'), '+0.15%p')
  assert.equal(formatFlowChange(-800_000_000_000, 'KRW'), '−8,000억원')
  assert.equal(formatFlowChange(null, 'KRW'), '—')
})

test('latestWithChange: 마지막 값과 바로 앞 영업일 대비 증감', () => {
  assert.deepEqual(latestWithChange([{ time: 1, value: 10 }, { time: 2, value: 13 }]), { latest: { time: 2, value: 13 }, change: 3 })
  assert.deepEqual(latestWithChange([{ time: 1, value: 10 }]), { latest: { time: 1, value: 10 }, change: null })
  assert.equal(latestWithChange([]), null)
})

test('toMarketFlows: 형식이 맞는 지표만, 점은 시각 순으로', () => {
  const parsed = toMarketFlows({
    latestTime: 2,
    metrics: [
      { metric: 'capital.invrDpsgAmt', label: '투자자예탁금', unit: 'KRW', points: [{ time: 2, value: 5 }, { time: 1, value: 4 }, { time: 'x', value: 1 }] },
      { metric: 'bad', label: 1, unit: 'KRW', points: [] },
    ],
  })
  assert.equal(parsed?.metrics.length, 1)
  assert.deepEqual(parsed?.metrics[0]?.points.map(point => point.time), [1, 2])
  assert.equal(toMarketFlows({ metrics: 'nope' }), null)
})

test('FLOW_GROUPS: 14개 지표가 한 번씩만 들어간다', () => {
  const all = FLOW_GROUPS.flatMap(group => group.metrics)
  assert.equal(all.length, 14)
  assert.equal(new Set(all).size, 14)
})
