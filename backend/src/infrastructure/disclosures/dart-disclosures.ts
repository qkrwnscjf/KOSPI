// DART 공시 목록·주요사항보고서 → Disclosure 정규화 (docs/Task_ORDER.md 12단계, D-59)
//
// ⚠️ 미확인 사항: 주요사항보고서 API 이름과 금액 필드 이름은 DART OpenAPI의 알려진 형식을 따른 가정이다.
// 첫 응답에서 필드 이름(값 제외)을 한 번 로그로 남겨 확정한다. 필드가 맞지 않으면 금액은 0이 아니라 null("금액 없음")이 된다.
//
// 개인정보: 공시 목록의 제출인(flr_nm)은 임원 개인 이름일 수 있어서 읽지 않는다 (D-59 ⑤).

import { RCEPT_NO_PATTERN, type Disclosure, type DisclosureGroup, type DisclosureKind } from '../../shared/disclosures.js';

export type DisclosureBase = Omit<Disclosure, 'amount' | 'live' | 'collectedAt' | 'producedAt'>;

// 주기 조회의 쪽 넘김 (plan.md QA-09 / P2-1, T-178)
// 예전: 한 주기에 5쪽(500건)까지만 읽고 읽은 접수번호를 모두 "봤음"으로 기록했다. 500건 넘게 밀리면 다음 주기는 1쪽에서
//       이미 본 공시를 만나 멈춰서 6쪽 이후는 재시작 전까지 읽히지 않았다(공시 마감일·한도 초과 뒤).
// 지금: 상한에 걸려 끝까지 못 읽으면 이어 읽을 쪽(nextPage)을 돌려준다. 다음 주기는 1쪽(새 공시)을 읽은 뒤 그 쪽부터 이어 읽는다.
//       새 공시는 앞쪽에 붙어서 뒤쪽 항목은 뒤로 밀리기만 하므로, 이어 읽는 쪽 번호가 같아도 빠지는 항목이 없다(겹치는 항목은 접수번호로 거른다).
export interface LivePage { rceptNos: string[]; rawCount: number; totalPage: number }
export interface LivePageOptions {
  firstPage: number;
  maxPages: number;
  pageSize: number;
  isSeen: (rceptNo: string) => boolean;
  stopOnSeen: boolean; // 1쪽부터 읽을 때만 참: 이미 본 공시가 나오면 그 뒤는 모두 본 공시
  shouldStop?: () => boolean;
}

export async function readLivePages<P extends LivePage>(fetchPage: (pageNo: number) => Promise<P>, options: LivePageOptions): Promise<{ pages: P[]; nextPage: number | null }> {
  const pages: P[] = [];
  const lastPage = options.firstPage + options.maxPages - 1;
  for (let pageNo = options.firstPage; pageNo <= lastPage; pageNo += 1) {
    if (options.shouldStop?.()) return { pages, nextPage: null };
    const page = await fetchPage(pageNo);
    pages.push(page);
    if (page.rawCount < options.pageSize || pageNo >= page.totalPage) return { pages, nextPage: null };
    if (options.stopOnSeen && page.rceptNos.some(options.isSeen)) return { pages, nextPage: null };
  }
  return { pages, nextPage: lastPage + 1 };
}

// 공시 제목 분류 규칙 (D-59 ③). 공백을 지운 제목에 대해 위에서부터 처음 맞는 규칙을 쓴다.
const RULES: { includes: string; group: DisclosureGroup; kind: DisclosureKind }[] = [
  { includes: '전환사채권발행결정', group: 'dilution', kind: 'cb' },
  { includes: '신주인수권부사채권발행결정', group: 'dilution', kind: 'bw' },
  { includes: '교환사채권발행결정', group: 'dilution', kind: 'eb' },
  { includes: '무상증자결정', group: 'other', kind: 'bonus_issue' },        // '유무상증자결정'은 classifyReport에서 먼저 처리
  { includes: '유상증자결정', group: 'dilution', kind: 'rights_offering' },
  { includes: '자기주식취득신탁계약체결결정', group: 'shareholder_return', kind: 'buyback_trust' },
  { includes: '자기주식취득결정', group: 'shareholder_return', kind: 'buyback' },
  { includes: '주식소각결정', group: 'shareholder_return', kind: 'cancellation' },
  { includes: '자기주식처분결정', group: 'treasury_disposal', kind: 'disposal' },
  { includes: '영업(잠정)실적', group: 'earnings', kind: 'earnings' },
  { includes: '매출액또는손익구조', group: 'earnings', kind: 'earnings' },
  { includes: '사업보고서', group: 'earnings', kind: 'periodic_report' },
  { includes: '반기보고서', group: 'earnings', kind: 'periodic_report' },
  { includes: '분기보고서', group: 'earnings', kind: 'periodic_report' },
  { includes: '대량보유상황보고서', group: 'ownership', kind: 'ownership' },
  { includes: '특정증권등소유상황보고서', group: 'ownership', kind: 'ownership' },
  { includes: '최대주주등소유주식변동', group: 'ownership', kind: 'ownership' },
  { includes: '최대주주변경', group: 'ownership', kind: 'ownership' },
];

const CORRECTION_PREFIX = /^\[[^\]]*정정[^\]]*\]/;

export function classifyReport(reportName: string): { group: DisclosureGroup; kind: DisclosureKind; isCorrection: boolean } {
  const compact = reportName.replace(/\s+/g, '');
  const isCorrection = CORRECTION_PREFIX.test(compact);
  // 종속회사·자회사의 결정(예: "유상증자결정(종속회사의주요경영사항)", "유상증자결정(자회사의 주요경영사항)")은
  // 이 회사의 희석·환원이 아니다
  if (compact.includes('종속회사') || compact.includes('자회사의주요경영사항')) return { group: 'other', kind: 'other', isCorrection };
  // 유상·무상을 함께 하는 경우는 희석으로 본다
  if (compact.includes('유무상증자결정')) return { group: 'dilution', kind: 'rights_offering', isCorrection };
  // 신탁계약 "해지"는 환원이 아니다
  if (compact.includes('자기주식취득신탁계약해지')) return { group: 'other', kind: 'other', isCorrection };
  const rule = RULES.find(item => compact.includes(item.includes));
  return rule ? { group: rule.group, kind: rule.kind, isCorrection } : { group: 'other', kind: 'other', isCorrection };
}

const CORP_CODE_PATTERN = /^\d{8}$/;
const STOCK_CODE_PATTERN = /^[0-9A-Z]{6}$/;
const DART_DATE_PATTERN = /^\d{8}$/;
const cleanText = (value: unknown, max: number) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';

// 순수 함수 (테스트 대상): 공시 목록의 한 항목 → 공통 형식. 유가증권(corp_cls 'Y')이 아니거나 필드가 맞지 않으면 null
export function mapListItem(item: unknown): DisclosureBase | null {
  if (!item || typeof item !== 'object') return null;
  const r = item as Record<string, unknown>;
  if (r.corp_cls !== 'Y') return null;
  const rceptNo = typeof r.rcept_no === 'string' ? r.rcept_no : '';
  const rceptDt = typeof r.rcept_dt === 'string' ? r.rcept_dt : '';
  const corpCode = typeof r.corp_code === 'string' ? r.corp_code : '';
  const stockCode = typeof r.stock_code === 'string' ? r.stock_code.trim() : '';
  const corpName = cleanText(r.corp_name, 100);
  const reportName = cleanText(r.report_nm, 300);
  if (!RCEPT_NO_PATTERN.test(rceptNo) || !DART_DATE_PATTERN.test(rceptDt) || !CORP_CODE_PATTERN.test(corpCode)) return null;
  if (!STOCK_CODE_PATTERN.test(stockCode) || !corpName || !reportName) return null;

  return {
    rceptNo,
    rceptDate: `${rceptDt.slice(0, 4)}-${rceptDt.slice(4, 6)}-${rceptDt.slice(6, 8)}`,
    corpCode,
    stockCode,
    corpName,
    reportName,
    ...classifyReport(reportName),
    market: 'KOSPI',
  };
}

// 금액을 조회하는 종류와 주요사항보고서 API (D-59 ④). 여러 필드면 합계(원).
// 유상증자: 자금조달 목적별 금액 합계 / 사채: 권면총액 / 자사주: 취득·처분 예정금액(보통주+기타주) / 신탁: 계약금액
export const DETAIL_ENDPOINTS: Partial<Record<DisclosureKind, { endpoint: string; fields: readonly string[] }>> = {
  rights_offering: { endpoint: 'piicDecsn.json', fields: ['fdpp_fclt', 'fdpp_bsninh', 'fdpp_op', 'fdpp_dtrp', 'fdpp_ocsa', 'fdpp_etc'] },
  cb: { endpoint: 'cvbdIsDecsn.json', fields: ['bd_fta'] },
  bw: { endpoint: 'bdwtIsDecsn.json', fields: ['bd_fta'] },
  eb: { endpoint: 'exbdIsDecsn.json', fields: ['bd_fta'] },
  buyback: { endpoint: 'tsstkAqDecsn.json', fields: ['aqpln_prc_ostk', 'aqpln_prc_estk'] },
  buyback_trust: { endpoint: 'tsstkAqTrctrCnsDecsn.json', fields: ['ctr_prc'] },
  disposal: { endpoint: 'tsstkDpDecsn.json', fields: ['dppln_prc_ostk', 'dppln_prc_estk'] },
};

// 금액 문자열('1,000,000', '-', '')을 숫자로. 없으면 null (0으로 대체하지 않음)
export function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/,/g, '');
  if (trimmed === '' || trimmed === '-') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// 여러 금액 필드의 합계. 모든 필드가 비어 있으면 null ("금액 없음")
export function sumAmountFields(row: Record<string, unknown>, fields: readonly string[]): number | null {
  let total: number | null = null;
  for (const field of fields) {
    const value = parseAmount(row[field]);
    if (value !== null) total = (total ?? 0) + value;
  }
  return total;
}

export const toDartDate = (isoDate: string) => isoDate.replace(/-/g, '');

// 과거 채우기 범위 (docs/security.md SEC-014, T-79). 날짜는 YYYYMMDD, 범위는 [시작, 끝] (양 끝 포함).
// - 저장된 것이 없으면 목표 기간 전체.
// - 저장된 첫 날짜가 목표 시작일보다 toleranceDays 넘게 늦으면 앞쪽 빈 기간 [목표 시작일, 저장된 첫 날짜 − 1일]을 받는다.
// - 뒤쪽은 저장된 마지막 날짜의 하루 전부터 오늘까지 받는다(그날 늦게 접수된 공시를 놓치지 않게). 중복은 DB가 갱신만 한다.
export function backfillRanges(targetStart: string, today: string, coverage: { earliest: string; latest: string } | null, toleranceDays = 3): [string, string][] {
  if (!coverage) return [[targetStart, today]];
  const ranges: [string, string][] = [];
  if (coverage.earliest > shiftYmd(targetStart, toleranceDays)) ranges.push([targetStart, shiftYmd(coverage.earliest, -1)]);
  const fromLatest = shiftYmd(coverage.latest, -1);
  ranges.push([fromLatest > targetStart ? fromLatest : targetStart, today]);
  return ranges;
}

function shiftYmd(date: string, days: number) {
  const ms = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}
