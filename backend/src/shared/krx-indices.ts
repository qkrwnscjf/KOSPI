// KRX 일별 지수 (docs/Task_ORDER.md T-67, D-60)
// 보류 중이던 Naver 6종(VKOSPI, KRX 섹터 5종)을 KRX Open API 일별 시세로 대체한다. 실시간이 아니라 하루 1개 값(종가)이다.
// 내부 심볼은 기존과 같다(화면·구독 허용 목록·DB가 그대로 씀). 제공처 지수 이름은 이 표에만 둔다.

export type KrxEndpoint = 'krx' | 'drvprod' | 'kospi';

// endpoint: krx = KRX 시리즈 일별 시세, drvprod = 파생상품지수 일별 시세, kospi = KOSPI 시리즈 일별 시세(과거 일봉 전용, 아래 표)
// names: 응답의 지수 이름(IDX_NM) 후보. 공백·대소문자를 무시하고 비교한다.
export const KRX_DAILY_INDICES = {
  VKOSPI: { endpoint: 'drvprod', category: 'domestic', names: ['코스피 200 변동성지수', '코스피200 변동성지수', 'VKOSPI'] },
  // 국내 전광판 확장 (D-67, T-102): KRX 시리즈 응답에 이미 들어 있는 대표 지수 3종(추가 호출 없음)
  KRX_VALUEUP: { endpoint: 'krx', category: 'domestic', names: ['코리아 밸류업 지수', '코리아밸류업지수', 'KOREA VALUE-UP INDEX'] },
  KRX_300: { endpoint: 'krx', category: 'domestic', names: ['KRX 300'] },
  KRX_100: { endpoint: 'krx', category: 'domestic', names: ['KRX 100'] },
  KRX_SEMI: { endpoint: 'krx', category: 'sector', names: ['KRX 반도체'] },
  KRX_IT: { endpoint: 'krx', category: 'sector', names: ['KRX 정보기술'] },
  KRX_AUTO: { endpoint: 'krx', category: 'sector', names: ['KRX 자동차'] },
  KRX_BANK: { endpoint: 'krx', category: 'sector', names: ['KRX 은행'] },
  KRX_BIO: { endpoint: 'krx', category: 'sector', names: ['KRX 헬스케어'] },
  // 섹터 확장 (D-66, 2026-10-22): KRX 시리즈 응답에서 이름을 확인한 섹터 지수 12종
  KRX_ENERGY_CHEM: { endpoint: 'krx', category: 'sector', names: ['KRX 에너지화학'] },
  KRX_STEEL: { endpoint: 'krx', category: 'sector', names: ['KRX 철강'] },
  KRX_TELECOM: { endpoint: 'krx', category: 'sector', names: ['KRX 방송통신'] },
  KRX_CONSTRUCTION: { endpoint: 'krx', category: 'sector', names: ['KRX 건설'] },
  KRX_SECURITIES: { endpoint: 'krx', category: 'sector', names: ['KRX 증권'] },
  KRX_MACHINERY: { endpoint: 'krx', category: 'sector', names: ['KRX 기계장비'] },
  KRX_INSURANCE: { endpoint: 'krx', category: 'sector', names: ['KRX 보험'] },
  KRX_TRANSPORT: { endpoint: 'krx', category: 'sector', names: ['KRX 운송'] },
  KRX_CONS_DISC: { endpoint: 'krx', category: 'sector', names: ['KRX 경기소비재'] },
  KRX_CONS_STAPLES: { endpoint: 'krx', category: 'sector', names: ['KRX 필수소비재'] },
  KRX_KCONTENT: { endpoint: 'krx', category: 'sector', names: ['KRX K콘텐츠'] },
  KRX_UTILITIES: { endpoint: 'krx', category: 'sector', names: ['KRX 유틸리티'] },
} as const satisfies Record<string, { endpoint: KrxEndpoint; category: 'domestic' | 'sector'; names: readonly string[] }>;

export type KrxDailySymbol = keyof typeof KRX_DAILY_INDICES;

export const KRX_DAILY_KEYS = Object.keys(KRX_DAILY_INDICES) as KrxDailySymbol[];

// 섹터 지수만 (화면의 섹터 수익률 노드, D-66)
export const KRX_SECTOR_KEYS = KRX_DAILY_KEYS.filter(symbol => KRX_DAILY_INDICES[symbol].category === 'sector');

export const isKrxDailySymbol = (value: unknown): value is KrxDailySymbol =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(KRX_DAILY_INDICES, value);

// Yahoo 실시간 지표의 과거 일봉을 KRX에서 받는 표 (docs/Task_ORDER.md T-104 보완, D-70)
// Yahoo가 과거 일봉을 주지 않는 지표만 둔다. 실시간 값은 Yahoo가 주므로 화면 tick으로 보내지 않고(Gateway가 건너뜀)
// index_daily에만 source 'krx'로 저장한다. History API가 1개월 ~ 1년 그래프에서 실시간 집계 앞에 이어 붙인다.
// 내부 심볼은 Yahoo 표(symbols.ts)와 같다.
export const KRX_HISTORY_INDICES = {
  KOSPI200: { endpoint: 'kospi', names: ['코스피 200', '코스피200'] },
  // 소스 간 대조 (T-119): 같은 응답에 있어 호출이 늘지 않는다. Yahoo 일봉과 거래소 값을 DB에서 비교한다. 화면 tick으로 보내지 않는다
  KOSPI: { endpoint: 'kospi', names: ['코스피'] },
} as const satisfies Record<string, { endpoint: KrxEndpoint; names: readonly string[] }>;

export type KrxHistorySymbol = keyof typeof KRX_HISTORY_INDICES;

export const KRX_HISTORY_KEYS = Object.keys(KRX_HISTORY_INDICES) as KrxHistorySymbol[];

export const isKrxHistorySymbol = (value: unknown): value is KrxHistorySymbol =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(KRX_HISTORY_INDICES, value);

export const normalizeIndexName = (name: string) => name.replace(/\s+/g, '').toUpperCase();

// 정규화한 지수 이름 → 내부 심볼 (엔드포인트별)
const NAME_LOOKUP = new Map<string, KrxDailySymbol | KrxHistorySymbol>();
for (const symbol of KRX_DAILY_KEYS) {
  const { endpoint, names } = KRX_DAILY_INDICES[symbol];
  for (const name of names) NAME_LOOKUP.set(`${endpoint}:${normalizeIndexName(name)}`, symbol);
}
for (const symbol of KRX_HISTORY_KEYS) {
  const { endpoint, names } = KRX_HISTORY_INDICES[symbol];
  for (const name of names) NAME_LOOKUP.set(`${endpoint}:${normalizeIndexName(name)}`, symbol);
}

export const symbolForIndexName = (endpoint: KrxEndpoint, name: string): KrxDailySymbol | KrxHistorySymbol | undefined =>
  NAME_LOOKUP.get(`${endpoint}:${normalizeIndexName(name)}`);
