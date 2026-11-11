// 시장별 정규 거래 시간 판단 (docs/Task_ORDER.md T-07, D-16)
// 시간대 변환은 Node 내장 Intl을 쓰므로 미국 서머타임도 자동으로 반영된다.
// 공휴일은 시간표로 알 수 없어서, 소스(Yahoo)의 장 상태와 함께 판단한다 (decideMarketStatus, T-56, D-40).

import type { YahooSymbolKey } from '../../shared/symbols.js';
import type { MarketState } from '../../shared/market-state.js';

export type MarketId = 'krx' | 'us_equity' | 'global_24h' | 'tokyo' | 'taiwan';

// 지표별로 따르는 시장 (frontend/src/constants/data.ts의 market과 같다)
export const YAHOO_MARKET: Record<YahooSymbolKey, MarketId> = {
  KOSPI: 'krx',
  KOSDAQ: 'krx',
  KOSPI200: 'krx',
  SAMSUNG: 'krx',
  SK_HYNIX: 'krx',
  HYUNDAI: 'krx',
  SP500: 'us_equity',
  NASDAQ: 'us_equity',
  SOX: 'us_equity',
  US10Y: 'us_equity',
  US13W: 'us_equity',
  US5Y: 'us_equity',
  US30Y: 'us_equity',
  // VIX는 미국 주식 장 밖(CBOE 연장 거래 시간으로 보임)에도 갱신된다(B-46 ① 재측정 1: 장 밖 10분에 40회).
  // 열린 시장 지표만 요청할 때(T-131) 빠지지 않도록 거의 24시간 시장으로 둔다.
  VIX: 'global_24h',
  DOW: 'us_equity',
  RUSSELL: 'us_equity',
  NIKKEI: 'tokyo',
  TAIEX: 'taiwan',
  'USD/KRW': 'global_24h',
  'JPY/KRW': 'global_24h',
  'CNY/KRW': 'global_24h',
  DXY: 'global_24h',
  WTI: 'global_24h',
  COPPER: 'global_24h',
  GOLD: 'global_24h',
  BRENT: 'global_24h',
  NATGAS: 'global_24h',
};

// open: 장중, holiday: 시간표상 장 시간인데 소스가 닫혀 있음(공휴일 등), closed: 장 시간 밖
export type MarketStatus = 'open' | 'holiday' | 'closed';

// 시간표와 소스 장 상태를 합쳐 판단한다 (T-56, D-40).
// - 장 시간 밖이면 소스와 상관없이 closed
// - 장 시간인데 그 시장의 지표 중 하나라도 REGULAR이거나, 소스 장 상태를 하나도 모르면 open (이전 동작과 같음)
// - 장 시간인데 소스가 모두 REGULAR가 아니면 holiday
export function decideMarketStatus(timeOpen: boolean, sourceStates: (MarketState | undefined)[]): MarketStatus {
  if (!timeOpen) return 'closed';
  const known = sourceStates.filter((state): state is MarketState => state !== undefined);
  if (known.length === 0 || known.includes('REGULAR')) return 'open';
  return 'holiday';
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formatters = new Map<string, Intl.DateTimeFormat>();

// 주어진 시간대의 요일(0=일요일), 자정 이후 분(minute), 날짜(YYYY-MM-DD)를 구한다.
function zonedClock(date: Date, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
  return {
    day: WEEKDAYS.indexOf(part('weekday')),
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
    date: `${part('year')}-${part('month')}-${part('day')}`,
  };
}

const isWeekday = (day: number) => day >= 1 && day <= 5;
const hm = (hour: number, minute = 0) => hour * 60 + minute;

// 국내 특수 거래일 (docs/Task_ORDER.md T-166, BENCHMARK B-69): 거래소가 그날만 장 시간을 바꾸는 날(수능일, 새해 첫 거래일).
// 요일 규칙으로 알 수 없어 서울 날짜별로 적는다. 거래소 공지로 확인한 날짜만 넣는다.
// frontend/src/lib/marketHours.ts에 같은 표가 있다. 바꾸면 두 파일을 함께 고친다.
// 이 표를 쓰는 곳: 장 열림(수집 요청·지연 측정·그래프 공백 판단·화면 배지), 마감 시각(공식 종가를 받는 시점, T-145)
export const KRX_SPECIAL_SESSIONS: Readonly<Record<string, { open: number; close: number; reason: string }>> = {
  '2026-11-19': { open: hm(10), close: hm(16, 30), reason: '대학수학능력시험: 개장·마감 1시간씩 늦춤' },
  '2027-01-04': { open: hm(10), close: hm(15, 30), reason: '새해 첫 거래일: 개장 1시간 늦춤' },
};
const KRX_REGULAR_SESSION = { open: hm(9), close: hm(15, 30) };
export const krxSession = (seoulDate: string) => KRX_SPECIAL_SESSIONS[seoulDate] ?? KRX_REGULAR_SESSION;

// 정규 장 마감 시각 (T-145). 24시간 시장은 하루 종가의 기준이 없어 넣지 않는다. 국내는 특수 거래일이면 그날 마감 시각을 쓴다(T-166)
const SESSION_CLOSE: Partial<Record<MarketId, { timeZone: string; close: number }>> = {
  krx: { timeZone: 'Asia/Seoul', close: KRX_REGULAR_SESSION.close },
  us_equity: { timeZone: 'America/New_York', close: hm(16) },
  tokyo: { timeZone: 'Asia/Tokyo', close: hm(15, 30) },
  taiwan: { timeZone: 'Asia/Taipei', close: hm(13, 30) },
};

// 마감 후 marginMs가 지난 가장 최근 평일 장의 마감 시각(ms). 공휴일은 시간표로 알 수 없어 평일로 친다(그날 봉이 없을 뿐이다).
// 일수를 빼서 계산하므로 미국 서머타임이 바뀌는 주말을 건너뛸 때 1시간 어긋날 수 있다(받는 시점만 달라지고 값은 같다).
export function latestSessionEnd(market: MarketId, nowMs: number, marginMs: number): number | null {
  const session = SESSION_CLOSE[market];
  if (!session) return null;
  const at = nowMs - marginMs;
  const { day, minutes, date } = zonedClock(new Date(at), session.timeZone);
  const closeOn = (back: number) => {
    if (market !== 'krx') return session.close;
    return krxSession(back === 0 ? date : zonedClock(new Date(at - back * 86_400_000), session.timeZone).date).close;
  };
  for (let back = 0; back <= 7; back += 1) {
    if (!isWeekday((day - back + 7) % 7)) continue;
    const close = closeOn(back);
    if (back === 0 && minutes < close) continue; // 오늘 장은 아직 끝나지 않음
    return at - (minutes - close) * 60_000 - back * 86_400_000;
  }
  return null;
}

export const MARKETS: { id: MarketId; isOpen: (now: Date) => boolean }[] = [
  {
    // KOSPI, KOSDAQ: 월~금 09:00 ~ 15:30 (서울). 특수 거래일은 KRX_SPECIAL_SESSIONS의 시간 (T-166)
    id: 'krx',
    isOpen: now => {
      const { day, minutes, date } = zonedClock(now, 'Asia/Seoul');
      const session = krxSession(date);
      return isWeekday(day) && minutes >= session.open && minutes < session.close;
    },
  },
  {
    // SP500, NASDAQ, SOX, US10Y: 월~금 09:30 ~ 16:00 (뉴욕). US10Y는 측정상 미국 장 시간에만 갱신됨 (B-08, B-10)
    id: 'us_equity',
    isOpen: now => {
      const { day, minutes } = zonedClock(now, 'America/New_York');
      return isWeekday(day) && minutes >= hm(9, 30) && minutes < hm(16);
    },
  },
  {
    // USD/KRW, DXY, WTI, COPPER: 일 18:00 ~ 금 17:00 (뉴욕). 주말만 닫힌다고 단순화 (선물의 일일 휴장 1시간은 무시)
    id: 'global_24h',
    isOpen: now => {
      const { day, minutes } = zonedClock(now, 'America/New_York');
      if (day === 6) return false;
      if (day === 0) return minutes >= hm(18);
      if (day === 5) return minutes < hm(17);
      return true;
    },
  },
  {
    // NIKKEI: 월~금 09:00 ~ 11:30, 12:30 ~ 15:30 (도쿄, 점심 휴장). 서머타임 없음
    id: 'tokyo',
    isOpen: now => {
      const { day, minutes } = zonedClock(now, 'Asia/Tokyo');
      return isWeekday(day) && ((minutes >= hm(9) && minutes < hm(11, 30)) || (minutes >= hm(12, 30) && minutes < hm(15, 30)));
    },
  },
  {
    // TAIEX: 월~금 09:00 ~ 13:30 (타이베이). 서머타임 없음
    id: 'taiwan',
    isOpen: now => {
      const { day, minutes } = zonedClock(now, 'Asia/Taipei');
      return isWeekday(day) && minutes >= hm(9) && minutes < hm(13, 30);
    },
  },
];
