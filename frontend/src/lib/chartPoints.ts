// 차트 점 계산 (docs/Task_ORDER.md T-25, T-27, D-37)
// 테스트할 수 있도록 React와 분리한 순수 함수다 (T-45). 다른 모듈을 import하지 않는다.

// 차트의 점 하나 (시각 ms, 값)
export interface ChartPoint {
  time: number
  value: number
}

export type Direction = 'up' | 'down' | 'flat'

export const MAX_REALTIME_POINTS = 50

// 시각 순서를 지키며 점을 추가한다. 같은 시각이면 값만 바꾸고, 더 이른 시각은 버린다.
export function appendPoint(points: ChartPoint[], point: ChartPoint) {
  const last = points[points.length - 1]
  if (last && point.time < last.time) return points
  if (last && point.time === last.time) return [...points.slice(0, -1), point]
  return [...points, point].slice(-MAX_REALTIME_POINTS)
}

// 최근 tick 응답과, 응답보다 먼저 도착한 실시간 tick을 합친다 (같은 시각은 실시간 값 우선).
export function mergePoints(fetched: ChartPoint[], live: ChartPoint[]) {
  const byTime = new Map<number, ChartPoint>()
  for (const point of [...fetched, ...live]) byTime.set(point.time, point)
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-MAX_REALTIME_POINTS)
}

// 캐시에 들어 있는 실시간 그래프(첫 화면 + 이어 붙인 tick)에 새 tick을 붙인다 (T-165 보완, B-68).
// 아직 첫 화면을 받지 않은 그래프(undefined)는 만들지 않는다. 일부 tick만으로 첫 화면을 대신하면 그 앞의 값이 빠지기 때문이다.
export function appendToSeries<T extends { points: ChartPoint[] }>(series: T | undefined, point: ChartPoint): T | undefined {
  if (!series) return undefined
  const points = appendPoint(series.points, point)
  return points === series.points ? series : { ...series, points }
}

// 그래프에 보이는 기간의 방향: 첫 값 대비 마지막 값 (D-37)
export function periodDirection(points: ChartPoint[]): Direction | null {
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last || points.length < 2) return null
  return last.value > first.value ? 'up' : last.value < first.value ? 'down' : 'flat'
}
