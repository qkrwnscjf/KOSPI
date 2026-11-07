// 차트 점 계산 테스트 (docs/Task_ORDER.md T-45, T-25, T-27, D-37)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_REALTIME_POINTS, appendPoint, appendToSeries, mergePoints, periodDirection } from '../src/lib/chartPoints.ts'

const point = (time: number, value = time) => ({ time, value })

test('appendToSeries: 첫 화면이 있는 캐시에만 tick을 붙이고, 없으면 만들지 않는다 (T-165 보완)', () => {
  const series = { notReady: false, points: [point(1, 10)] }
  assert.deepEqual(appendToSeries(series, point(2, 11))?.points, [point(1, 10), point(2, 11)])
  assert.equal(appendToSeries(series, point(0, 9)), series) // 더 이른 시각은 버리고 같은 객체 그대로
  assert.equal(appendToSeries(undefined, point(2, 11)), undefined)
})

test('appendPoint: 새 시각의 점은 뒤에 붙는다', () => {
  assert.deepEqual(appendPoint([point(1)], point(2)), [point(1), point(2)])
})

test('appendPoint: 같은 시각이면 값만 바꾼다', () => {
  assert.deepEqual(appendPoint([point(1), point(2, 20)], point(2, 21)), [point(1), point(2, 21)])
})

test('appendPoint: 더 이른 시각(늦게 도착한 오래된 값)은 버린다', () => {
  const points = [point(1), point(5)]
  assert.equal(appendPoint(points, point(3)), points)
})

test('appendPoint: 최대 50개를 넘으면 오래된 점부터 버린다', () => {
  let points: ReturnType<typeof point>[] = []
  for (let time = 1; time <= MAX_REALTIME_POINTS + 10; time++) points = appendPoint(points, point(time))
  assert.equal(points.length, MAX_REALTIME_POINTS)
  assert.equal(points[0]?.time, 11)
})

test('mergePoints: 최근 tick과 먼저 도착한 실시간 tick을 시각 순으로 합치고, 같은 시각은 실시간 값을 쓴다', () => {
  const fetched = [point(1), point(2, 20), point(3)]
  const live = [point(2, 22), point(4)]
  assert.deepEqual(mergePoints(fetched, live), [point(1), point(2, 22), point(3), point(4)])
})

test('mergePoints: 합친 뒤에도 최대 50개', () => {
  const fetched = Array.from({ length: 60 }, (_, index) => point(index + 1))
  assert.equal(mergePoints(fetched, []).length, MAX_REALTIME_POINTS)
})

test('periodDirection: 첫 값 대비 마지막 값으로 방향을 정한다 (D-37)', () => {
  assert.equal(periodDirection([point(1, 10), point(2, 5), point(3, 12)]), 'up')
  assert.equal(periodDirection([point(1, 10), point(2, 15), point(3, 9)]), 'down')
  assert.equal(periodDirection([point(1, 10), point(2, 10)]), 'flat')
  assert.equal(periodDirection([point(1, 10)]), null)
  assert.equal(periodDirection([]), null)
})
