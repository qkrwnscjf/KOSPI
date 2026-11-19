// 그래프의 글 대안 (plan.md FQA-11, T-197)
// 그래프는 그림이라 화면 읽기 프로그램이 내용을 알 수 없었다. 카드의 그래프 영역에 시작·마지막 값과 기간 등락을 한 줄로 단다.
// 테스트할 수 있도록 React와 분리한 순수 함수다(`@/` 별칭 없음).

export interface SummaryPoint { time: number; value: number }

export function chartSummary(title: string, range: string, points: readonly SummaryPoint[], format: (value: number) => string): string {
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return `${title} ${range} 그래프: 표시할 데이터 없음`
  if (points.length === 1) return `${title} ${range} 그래프: 값 ${format(last.value)}, 점 1개`
  const change = first.value !== 0 ? ((last.value - first.value) / Math.abs(first.value)) * 100 : null
  const changeText = change === null ? '' : ` (${change > 0 ? '+' : ''}${change.toFixed(2)}%)`
  return `${title} ${range} 그래프: 시작 ${format(first.value)}, 마지막 ${format(last.value)}${changeText}, 점 ${points.length}개`
}
