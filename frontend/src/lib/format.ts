// 숫자·시각 표시 (docs/Task_ORDER.md T-41)

// 지표마다 정한 자릿수로 표시한다. 자릿수를 고정해서 값이 바뀔 때 글자 폭이 흔들리지 않게 한다.
export function formatNumber(value: number, decimals: number) {
  return value.toLocaleString('ko-KR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

// 축 눈금은 공간이 좁아서 끝자리 0을 생략한다.
export function formatAxisNumber(value: number, decimals: number) {
  return value.toLocaleString('ko-KR', { maximumFractionDigits: decimals })
}

// 날짜·시각은 브라우저 시간대가 아니라 서울 시간으로 보여 준다 (plan.md QA-32 / P4-2, T-215).
// 일별 값은 15:30 KST 시각으로 저장되어, 서쪽 시간대(예: 하와이)의 브라우저에서는 하루 전 날짜로 보였다.
// 시장 판단(lib/marketHours.ts)과 같은 방식으로 Intl에 시간대를 지정한다
const SEOUL_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

function seoulParts(ms: number) {
  const parts = SEOUL_PARTS.formatToParts(new Date(ms))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute'), second: part('second') }
}

export function formatClock(ms: number, withSeconds = true) {
  const { hour, minute, second } = seoulParts(ms)
  const time = `${hour}:${minute}`
  return withSeconds ? `${time}:${second}` : time
}

export function formatDate(ms: number, withYear = false) {
  const { year, month, day } = seoulParts(ms)
  const monthDay = `${month}/${day}`
  return withYear ? `${year}/${monthDay}` : monthDay
}
