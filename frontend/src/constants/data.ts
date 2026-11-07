import type { MarketId } from '@/lib/marketHours'

// 카드 목록. 첫 화면은 mock 데이터 없이 실제 값(최근 tick, 캐시된 최신값)으로 채운다 (docs/Task_ORDER.md T-25, P-02).
// ready: false인 지표는 수집이 보류 중이라(R-03) "데이터 준비 중"으로 표시하고, 서버에 요청하지 않는다 (T-26, R-04).
//
// 표시 설정 (T-41, T-42)
// - decimals: 현재가 소수 자릿수. 축 눈금도 이 자릿수까지만 쓴다.
// - prefix / suffix: 단위
// - market: 장 상태(장중 / 장 마감)를 판단할 시장 (lib/marketHours.ts)
// - 지연 배지는 여기 적지 않는다. backend가 장중에 측정한 값을 카드가 받아 보여 준다 (T-162, `/api/v1/market/source-lags`)
// - daily: 하루 1개 값(종가)만 있는 지표. KRX Open API 일별 시세 (T-67). 실시간·1일 그래프 없이 1주 ~ 1년만 보여 준다.
// - group: 카테고리 안의 소분류 제목 (T-108). 같은 group끼리 묶어서 보여 준다. 없으면 묶지 않는다.
// - spread: 두 지표의 차이를 보여 주는 계산 카드 (T-107). 저장·구독 방 없이 long − short로 계산하고, 실시간 그래프는 없다.

export interface ChartCardConfig {
  title: string
  symbol: string
  ready: boolean
  decimals: number
  prefix?: string
  suffix?: string
  market?: MarketId
  daily?: boolean
  group?: string
  spread?: { long: string; short: string }
}

export const CATEGORY_DATA: Record<string, ChartCardConfig[]> = {
  // 지표 확장 (D-67, D-70): 새 Yahoo 지표의 과거 1개월 ~ 1년은 과거 일봉을 이어 붙인다 (T-104 ③). 카드는 소분류로 묶는다 (T-108)
  category1: [
    { title: '코스피 지수', symbol: 'KOSPI', ready: true, decimals: 2, suffix: 'pt', market: 'krx', group: '지수' },
    { title: '코스닥 지수', symbol: 'KOSDAQ', ready: true, decimals: 2, suffix: 'pt', market: 'krx', group: '지수' },
    { title: '코스피 200', symbol: 'KOSPI200', ready: true, decimals: 2, suffix: 'pt', market: 'krx', group: '지수' },
    { title: '삼성전자', symbol: 'SAMSUNG', ready: true, decimals: 0, suffix: '원', market: 'krx', group: '대형주' },
    { title: 'SK하이닉스', symbol: 'SK_HYNIX', ready: true, decimals: 0, suffix: '원', market: 'krx', group: '대형주' },
    { title: '현대차', symbol: 'HYUNDAI', ready: true, decimals: 0, suffix: '원', market: 'krx', group: '대형주' },
    { title: '코스피200 변동성지수', symbol: 'VKOSPI', ready: true, decimals: 2, daily: true, group: 'KRX 일별 지수' },
    { title: '코리아 밸류업 지수', symbol: 'KRX_VALUEUP', ready: true, decimals: 2, suffix: 'pt', daily: true, group: 'KRX 일별 지수' },
    { title: 'KRX 300', symbol: 'KRX_300', ready: true, decimals: 2, suffix: 'pt', daily: true, group: 'KRX 일별 지수' },
    { title: 'KRX 100', symbol: 'KRX_100', ready: true, decimals: 2, suffix: 'pt', daily: true, group: 'KRX 일별 지수' },
  ],
  category2: [
    { title: '원/달러 환율', symbol: 'USD/KRW', ready: true, decimals: 2, suffix: '원', market: 'global_24h', group: '환율' },
    { title: '엔/원 환율 (1엔)', symbol: 'JPY/KRW', ready: true, decimals: 3, suffix: '원', market: 'global_24h', group: '환율' },
    { title: '위안/원 환율', symbol: 'CNY/KRW', ready: true, decimals: 2, suffix: '원', market: 'global_24h', group: '환율' },
    { title: '달러 인덱스', symbol: 'DXY', ready: true, decimals: 2, suffix: 'pt', market: 'global_24h', group: '환율' },
    { title: '미 국채 13주', symbol: 'US13W', ready: true, decimals: 3, suffix: '%', market: 'us_equity', group: '미국 금리' },
    { title: '미 국채 5년물', symbol: 'US5Y', ready: true, decimals: 3, suffix: '%', market: 'us_equity', group: '미국 금리' },
    { title: '미 국채 10년물', symbol: 'US10Y', ready: true, decimals: 3, suffix: '%', market: 'us_equity', group: '미국 금리' },
    { title: '미 국채 30년물', symbol: 'US30Y', ready: true, decimals: 3, suffix: '%', market: 'us_equity', group: '미국 금리' },
    { title: '장단기 금리차 (10년 − 13주)', symbol: 'US_SPREAD', ready: true, decimals: 3, suffix: '%p', market: 'us_equity', group: '미국 금리', spread: { long: 'US10Y', short: 'US13W' } },
    { title: 'VIX 변동성 지수', symbol: 'VIX', ready: true, decimals: 2, market: 'us_equity', group: '변동성' },
  ],
  category3: [
    { title: 'S&P 500', symbol: 'SP500', ready: true, decimals: 2, suffix: 'pt', market: 'us_equity', group: '미국 지수' },
    { title: '나스닥 100', symbol: 'NASDAQ', ready: true, decimals: 2, suffix: 'pt', market: 'us_equity', group: '미국 지수' },
    { title: '다우존스 산업평균', symbol: 'DOW', ready: true, decimals: 2, suffix: 'pt', market: 'us_equity', group: '미국 지수' },
    { title: '러셀 2000', symbol: 'RUSSELL', ready: true, decimals: 2, suffix: 'pt', market: 'us_equity', group: '미국 지수' },
    { title: '필라델피아 반도체', symbol: 'SOX', ready: true, decimals: 2, suffix: 'pt', market: 'us_equity', group: '미국 지수' },
    { title: '니케이 225', symbol: 'NIKKEI', ready: true, decimals: 2, suffix: 'pt', market: 'tokyo', group: '아시아 지수' },
    { title: '대만 가권', symbol: 'TAIEX', ready: true, decimals: 2, suffix: 'pt', market: 'taiwan', group: '아시아 지수' },
    { title: 'WTI 원유 선물', symbol: 'WTI', ready: true, decimals: 2, prefix: '$', market: 'global_24h', group: '원자재' },
    { title: '브렌트유 선물', symbol: 'BRENT', ready: true, decimals: 2, prefix: '$', market: 'global_24h', group: '원자재' },
    { title: '천연가스 선물', symbol: 'NATGAS', ready: true, decimals: 3, prefix: '$', market: 'global_24h', group: '원자재' },
    { title: '금 선물', symbol: 'GOLD', ready: true, decimals: 2, prefix: '$', market: 'global_24h', group: '원자재' },
    { title: '구리 선물', symbol: 'COPPER', ready: true, decimals: 4, prefix: '$', market: 'global_24h', group: '원자재' },
  ],
  category4: [
    { title: 'KRX 반도체', symbol: 'KRX_SEMI', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX 정보기술(IT)', symbol: 'KRX_IT', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX 자동차', symbol: 'KRX_AUTO', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX 은행', symbol: 'KRX_BANK', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX 헬스케어', symbol: 'KRX_BIO', ready: true, decimals: 2, suffix: 'pt', daily: true },
    // 섹터 확장 (D-66): KRX 섹터 지수 12종 (일별 시세)
    { title: 'KRX 에너지화학', symbol: 'KRX_ENERGY_CHEM', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX 철강', symbol: 'KRX_STEEL', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX 방송통신', symbol: 'KRX_TELECOM', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX 건설', symbol: 'KRX_CONSTRUCTION', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX 증권', symbol: 'KRX_SECURITIES', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX 기계장비', symbol: 'KRX_MACHINERY', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX 보험', symbol: 'KRX_INSURANCE', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX 운송', symbol: 'KRX_TRANSPORT', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX 경기소비재', symbol: 'KRX_CONS_DISC', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX 필수소비재', symbol: 'KRX_CONS_STAPLES', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX K콘텐츠', symbol: 'KRX_KCONTENT', ready: true, decimals: 2, suffix: 'pt', daily: true },
    { title: 'KRX 유틸리티', symbol: 'KRX_UTILITIES', ready: true, decimals: 2, suffix: 'pt', daily: true },
  ],
}
