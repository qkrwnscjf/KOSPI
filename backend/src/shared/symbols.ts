import { DISCLOSURE_ROOM } from './disclosures.js';
import { KRX_DAILY_KEYS } from './krx-indices.js';

// Yahoo 심볼 표와 카테고리 표 (docs/Task_ORDER.md T-22)
// 이전에는 yahoo-api.ts와 history.controller.ts에 따로 정의되어 있었다 (P-17).
// 실시간 수집, 과거 데이터 채우기, History API가 모두 이 표를 쓴다.

export const YAHOO_SYMBOLS = {
  // Domestic
  KOSPI: '^KS11',
  KOSDAQ: '^KQ11',
  // 국내 전광판 확장 (D-67, T-103): 코스피 200과 대형주 3종(주가)
  KOSPI200: '^KS200',
  SAMSUNG: '005930.KS', // 삼성전자
  SK_HYNIX: '000660.KS', // SK하이닉스
  HYUNDAI: '005380.KS', // 현대차
  // Macro
  'USD/KRW': 'KRW=X',
  DXY: 'DX-Y.NYB',
  'US10Y': '^TNX', // 미 10년물 금리
  // 매크로·환율 확장 (D-67, T-103)
  'JPY/KRW': 'JPYKRW=X', // 엔/원 (1엔당 원)
  'CNY/KRW': 'CNYKRW=X', // 위안/원
  US13W: '^IRX', // 미 13주 국채 금리
  US5Y: '^FVX', // 미 5년물 금리
  US30Y: '^TYX', // 미 30년물 금리
  VIX: '^VIX', // CBOE 변동성 지수
  // Global
  SP500: '^GSPC',
  NASDAQ: '^NDX',
  SOX: '^SOX', // 필라델피아 반도체
  WTI: 'CL=F', // 원유
  COPPER: 'HG=F', // 구리
  // 글로벌 연동 확장 (D-67, T-103). 홍콩·상해는 넣지 않음, 비트코인은 완전 제외 (D-70)
  DOW: '^DJI', // 다우존스 산업평균
  RUSSELL: '^RUT', // 러셀 2000
  NIKKEI: '^N225', // 니케이 225
  TAIEX: '^TWII', // 대만 가권
  GOLD: 'GC=F', // 금 선물
  BRENT: 'BZ=F', // 브렌트유 선물
  NATGAS: 'NG=F' // 천연가스 선물
} as const;

export type YahooSymbolKey = keyof typeof YAHOO_SYMBOLS;

export const YAHOO_CATEGORY: Record<YahooSymbolKey, 'domestic' | 'macro' | 'global'> = {
  KOSPI: 'domestic',
  KOSDAQ: 'domestic',
  KOSPI200: 'domestic',
  SAMSUNG: 'domestic',
  SK_HYNIX: 'domestic',
  HYUNDAI: 'domestic',
  'USD/KRW': 'macro',
  DXY: 'macro',
  'US10Y': 'macro',
  'JPY/KRW': 'macro',
  'CNY/KRW': 'macro',
  US13W: 'macro',
  US5Y: 'macro',
  US30Y: 'macro',
  VIX: 'macro',
  SP500: 'global',
  NASDAQ: 'global',
  SOX: 'global',
  WTI: 'global',
  COPPER: 'global',
  DOW: 'global',
  RUSSELL: 'global',
  NIKKEI: 'global',
  TAIEX: 'global',
  GOLD: 'global',
  BRENT: 'global',
  NATGAS: 'global'
};

export const YAHOO_KEYS = Object.keys(YAHOO_SYMBOLS) as YahooSymbolKey[];

export const isYahooSymbolKey = (value: string): value is YahooSymbolKey =>
  Object.prototype.hasOwnProperty.call(YAHOO_SYMBOLS, value);

// 최초 과거 데이터 채우기(backfill.ts 버전 2) 뒤에 추가한 Yahoo 지표 (docs/Task_ORDER.md T-104 ③, D-67)
// 이 지표들의 과거는 집계(market_ticks → 5분·1시간·1일 봉)를 다시 계산하지 않고, 과거 일봉만 index_daily에
// source 'yahoo'로 넣는다. 다시 계산하면 그 구간의 다른 지표 집계가 지워지기 때문이다(원본이 이미 없음, D-23).
// History API가 1개월 ~ 1년 그래프에서 집계가 시작되기 전 날짜를 이 일봉으로 이어 붙인다.
export const YAHOO_DAILY_HISTORY_KEYS: readonly YahooSymbolKey[] = [
  'KOSPI200', 'SAMSUNG', 'SK_HYNIX', 'HYUNDAI',
  'JPY/KRW', 'CNY/KRW', 'US13W', 'US5Y', 'US30Y', 'VIX',
  'DOW', 'RUSSELL', 'NIKKEI', 'TAIEX', 'GOLD', 'BRENT', 'NATGAS',
];
export const YAHOO_DAILY_SOURCE = 'yahoo';

// 저장하지 않고 조회할 때 계산하는 지표 (docs/Task_ORDER.md T-107): 두 지표의 차이 = long − short
// 미 장단기 금리차 = 10년물 − 13주. 구독 방(room)이 없고, 화면은 두 지표의 tick으로 현재값을 계산한다.
export const DERIVED_SPREADS = {
  US_SPREAD: { long: 'US10Y', short: 'US13W' },
} as const satisfies Record<string, { long: YahooSymbolKey; short: YahooSymbolKey }>;

export type DerivedSymbol = keyof typeof DERIVED_SPREADS;

export const isDerivedSymbol = (value: unknown): value is DerivedSymbol =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(DERIVED_SPREADS, value);

// 브라우저가 구독할 수 있는 심볼 (docs/security.md SEC-005). 이 목록에 없는 값으로는 방(room)을 만들지 않는다.
// 공시 방(`disclosures:KOSPI`, 12단계)도 포함한다. 투자자별 흐름 방(`flows:*`)은 데이터 원천이 없어 T-164에서 뺐다.
// KRX 일별 지수는 표(krx-indices.ts)에 있는 심볼 전체(VKOSPI·대표 지수 3종·섹터 17종)를 허용한다.
const SUBSCRIBABLE_SYMBOLS = new Set<string>([...YAHOO_KEYS, ...KRX_DAILY_KEYS, DISCLOSURE_ROOM]);

export const isSubscribableSymbol = (value: unknown): value is string =>
  typeof value === 'string' && SUBSCRIBABLE_SYMBOLS.has(value);
