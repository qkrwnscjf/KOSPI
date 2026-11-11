// 시장별 정규 거래 시간 — 화면 표시용 (docs/Task_ORDER.md T-42, D-36)
// backend/src/infrastructure/ingestion/market-hours.ts와 같은 규칙이다. 규칙을 바꾸면 두 파일을 함께 고친다.
// 서버에 묻지 않고 브라우저의 Intl로 판단해서, 장 상태를 보여 주려고 요청이 늘지 않는다.
// 공휴일은 시간표로 알 수 없어서, tick에 담겨 오는 소스 장 상태(marketState)와 함께 판단한다 (marketBadge, T-56).

export type MarketId = 'krx' | 'us_equity' | 'global_24h' | 'tokyo' | 'taiwan'

// 소스(Yahoo)의 장 상태 (backend/src/shared/market-state.ts와 같은 값)
export type MarketState = 'PREPRE' | 'PRE' | 'REGULAR' | 'POST' | 'POSTPOST' | 'CLOSED'

export type MarketBadgeLabel = '장중' | '휴장' | '장 시작 전' | '장 마감'

// 카드의 장 상태 배지 (T-42, T-56). backend의 decideMarketStatus와 같은 규칙에 화면용 구분을 더했다.
// - 장 시간 밖: 장 마감
// - 장 시간 + 소스 REGULAR 또는 소스 정보 없음: 장중
// - 장 시간 + 소스 CLOSED: 휴장(공휴일 등)
// - 장 시간 + 소스 PRE / POST: 장 시작 전 / 장 마감(조기 폐장 등)
export function marketBadge(timeOpen: boolean, state: MarketState | undefined): { label: MarketBadgeLabel; open: boolean } {
  if (!timeOpen) return { label: '장 마감', open: false }
  if (state === undefined || state === 'REGULAR') return { label: '장중', open: true }
  if (state === 'CLOSED') return { label: '휴장', open: false }
  if (state === 'PRE' || state === 'PREPRE') return { label: '장 시작 전', open: false }
  return { label: '장 마감', open: false }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const formatters = new Map<string, Intl.DateTimeFormat>()

// 주어진 시간대의 요일(0=일요일), 자정 이후 분(minute), 날짜(YYYY-MM-DD)
function zonedClock(date: Date, timeZone: string) {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
    formatters.set(timeZone, formatter)
  }
  const parts = formatter.formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? ''
  return {
    day: WEEKDAYS.indexOf(part('weekday')),
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
    date: `${part('year')}-${part('month')}-${part('day')}`,
  }
}

const isWeekday = (day: number) => day >= 1 && day <= 5
const hm = (hour: number, minute = 0) => hour * 60 + minute

// 국내 특수 거래일 (T-166): backend market-hours.ts의 KRX_SPECIAL_SESSIONS와 같은 표다. 바꾸면 두 파일을 함께 고친다
const KRX_SPECIAL_SESSIONS: Readonly<Record<string, { open: number; close: number }>> = {
  '2026-11-19': { open: hm(10), close: hm(16, 30) }, // 대학수학능력시험
  '2027-01-04': { open: hm(10), close: hm(15, 30) }, // 새해 첫 거래일
}
const KRX_REGULAR_SESSION = { open: hm(9), close: hm(15, 30) }

export function isMarketOpen(market: MarketId, now: Date): boolean {
  if (market === 'krx') {
    // KOSPI, KOSDAQ: 월~금 09:00 ~ 15:30 (서울). 특수 거래일은 표의 시간
    const { day, minutes, date } = zonedClock(now, 'Asia/Seoul')
    const session = KRX_SPECIAL_SESSIONS[date] ?? KRX_REGULAR_SESSION
    return isWeekday(day) && minutes >= session.open && minutes < session.close
  }
  if (market === 'tokyo') {
    // NIKKEI: 월~금 09:00 ~ 11:30, 12:30 ~ 15:30 (도쿄, 점심 휴장)
    const { day, minutes } = zonedClock(now, 'Asia/Tokyo')
    return isWeekday(day) && ((minutes >= hm(9) && minutes < hm(11, 30)) || (minutes >= hm(12, 30) && minutes < hm(15, 30)))
  }
  if (market === 'taiwan') {
    // TAIEX: 월~금 09:00 ~ 13:30 (타이베이)
    const { day, minutes } = zonedClock(now, 'Asia/Taipei')
    return isWeekday(day) && minutes >= hm(9) && minutes < hm(13, 30)
  }
  const { day, minutes } = zonedClock(now, 'America/New_York')
  if (market === 'us_equity') {
    // SP500, NASDAQ, SOX, US10Y: 월~금 09:30 ~ 16:00 (뉴욕)
    return isWeekday(day) && minutes >= hm(9, 30) && minutes < hm(16)
  }
  // USD/KRW, DXY, WTI, COPPER: 일 18:00 ~ 금 17:00 (뉴욕)
  if (day === 6) return false
  if (day === 0) return minutes >= hm(18)
  if (day === 5) return minutes < hm(17)
  return true
}
