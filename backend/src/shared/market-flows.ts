// 증시 자금 흐름 일별 통계 (docs/Task_ORDER.md 11단계 B′ T-95 ~ T-97, D-44, D-65)
// 공공데이터포털 금융투자협회 종합통계(증시자금추이, 신용공여잔고추이)의 하루치 값을 지표·날짜·값으로 다룬다.
// 응답 필드 이름은 첫 응답으로 확인한다(D-53 방식). 그래서 숫자 필드를 모두 지표로 받고, 이름은 형식만 검사한다.
// 값이 없거나 숫자가 아니면 0으로 채우지 않고 뺀다(D-14와 같은 원칙).

import { isPlausibleEventTime } from './event-time.js';

export const MARKET_FLOW_DATASETS = ['capital', 'credit'] as const;
export type MarketFlowDataset = (typeof MARKET_FLOW_DATASETS)[number];

// 데이터셋 하루치 메시지 (Kafka `market-flows`)
export interface MarketFlow {
  time: number; // 기준일 15:30 KST (KRX 일별 값과 같은 기준)
  dataset: MarketFlowDataset;
  values: Record<string, number>;
  collectedAt?: number;
  producedAt?: number;
}

// 표시용 이름·단위 (2026-10-28 확정): 포털 출력결과 명세에 국문명·설명이 없어, 원본 통계 사이트(금융투자협회 종합통계 freesis)의
// 10/23 화면과 대조해 정했다. 이름은 freesis 열 제목과 같고, 저장 값은 원 단위(freesis 표시 단위 백만원 × 1,000,000)다.
// 유가증권(Scrs) + 코스닥(Kosdaq) = 전체(Whl)는 저장 값 합계로도 확인했다(B-47). 비중은 %.
export const MARKET_FLOW_METRICS: Record<string, { label: string; unit: 'KRW' | 'percent' }> = {
  'capital.invrDpsgAmt': { label: '투자자예탁금', unit: 'KRW' },
  'capital.onbdDrvPrdTrRcAdvAmt': { label: '장내파생상품 거래예수금', unit: 'KRW' },
  'capital.toCstRpchCndBndSlgBal': { label: '대고객 환매조건부채권(RP) 매도잔고', unit: 'KRW' },
  'capital.brkTrdUcolMny': { label: '위탁매매 미수금', unit: 'KRW' },
  'capital.brkTrdUcolMnyVsOppsTrdAmt': { label: '미수금 대비 반대매매금액', unit: 'KRW' },
  'capital.ucolMnyVsOppsTrdRlImpt': { label: '미수금 대비 반대매매비중', unit: 'percent' },
  'credit.crdTrFingWhl': { label: '신용거래융자 전체', unit: 'KRW' },
  'credit.crdTrFingScrs': { label: '신용거래융자 유가증권', unit: 'KRW' },
  'credit.crdTrFingKosdaq': { label: '신용거래융자 코스닥', unit: 'KRW' },
  'credit.crdTrLndrWhl': { label: '신용거래대주 전체', unit: 'KRW' },
  'credit.crdTrLndrScrs': { label: '신용거래대주 유가증권', unit: 'KRW' },
  'credit.crdTrLndrKosdaq': { label: '신용거래대주 코스닥', unit: 'KRW' },
  'credit.sbscCapLn': { label: '청약자금대출', unit: 'KRW' },
  'credit.dpsgScrtMogFing': { label: '예탁증권담보융자', unit: 'KRW' },
};

// 지표 이름 = 응답 필드 이름. 외부 문자열이라 영문·숫자·밑줄만, 길이 40자까지
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export const MAX_FIELDS = 60;
const DATE_FIELD = 'basDt';

const isDataset = (value: unknown): value is MarketFlowDataset =>
  typeof value === 'string' && (MARKET_FLOW_DATASETS as readonly string[]).includes(value);

export type MarketFlowParseResult = { ok: true; flow: MarketFlow } | { ok: false; reason: string };

// Kafka 메시지 검증 (db-sink). 예외를 던지지 않는다 (SEC-002)
export function parseMarketFlow(input: Buffer | null | undefined): MarketFlowParseResult {
  if (!input) return { ok: false, reason: 'empty' };
  let data: unknown;
  try {
    data = JSON.parse(input.toString());
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!data || typeof data !== 'object') return { ok: false, reason: 'not_object' };
  const { time, dataset, values, collectedAt, producedAt } = data as Record<string, unknown>;
  if (!isPlausibleEventTime(time)) return { ok: false, reason: 'time' };
  if (!isDataset(dataset)) return { ok: false, reason: 'dataset' };
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { ok: false, reason: 'values' };
  const entries = Object.entries(values as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_FIELDS) return { ok: false, reason: 'values_count' };
  const clean: Record<string, number> = {};
  for (const [name, value] of entries) {
    if (!FIELD_NAME.test(name) || typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'value' };
    clean[name] = value;
  }
  const flow: MarketFlow = { time, dataset, values: clean };
  if (typeof collectedAt === 'number' && Number.isFinite(collectedAt)) flow.collectedAt = collectedAt;
  if (typeof producedAt === 'number' && Number.isFinite(producedAt)) flow.producedAt = producedAt;
  return { ok: true, flow };
}

// 공공데이터포털 JSON 응답 → 결과 코드와 행 목록. item이 한 건이면 객체로 오는 경우도 받는다
export function readDataGoKrResponse(body: unknown) {
  const response = body && typeof body === 'object' ? (body as Record<string, unknown>).response : undefined;
  const header = response && typeof response === 'object' ? (response as Record<string, unknown>).header : undefined;
  const content = response && typeof response === 'object' ? (response as Record<string, unknown>).body : undefined;
  const { resultCode, resultMsg } = header && typeof header === 'object' ? (header as Record<string, unknown>) : {};
  const { items, totalCount } = content && typeof content === 'object' ? (content as Record<string, unknown>) : {};
  const item = items && typeof items === 'object' ? (items as Record<string, unknown>).item : undefined;
  const list = Array.isArray(item) ? item : item && typeof item === 'object' ? [item] : [];
  return {
    resultCode: typeof resultCode === 'string' ? resultCode : null,
    resultMsg: typeof resultMsg === 'string' ? resultMsg : null,
    totalCount: typeof totalCount === 'number' ? totalCount : Number(totalCount ?? NaN),
    rows: list.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row)),
  };
}

const parseNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/,/g, '');
  if (trimmed === '' || trimmed === '-') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

// 기준일(YYYYMMDD) 15:30 KST = 06:30 UTC
export const dailyCloseTime = (basDt: string) =>
  Date.UTC(Number(basDt.slice(0, 4)), Number(basDt.slice(4, 6)) - 1, Number(basDt.slice(6, 8)), 6, 30);

// 한 행의 숫자 필드만 고른다(기준일 필드 제외). 이름 형식이 맞지 않거나 숫자가 아닌 필드는 건너뛴다
function numericFields(row: Record<string, unknown>) {
  const values: Record<string, number> = {};
  let skipped = 0;
  for (const [name, raw] of Object.entries(row)) {
    if (name === DATE_FIELD) continue;
    const value = parseNumber(raw);
    if (!FIELD_NAME.test(name) || value === null || Object.keys(values).length >= MAX_FIELDS) {
      skipped += 1;
      continue;
    }
    values[name] = value;
  }
  return { values, skipped };
}

// 행 목록 → 기준일별 숫자 필드 (기준일 오래된 순).
// 같은 날짜에 행이 여러 개면(시장별로 나뉜 응답 등) 필드가 겹칠 수 있어 그 날은 저장하지 않고 사유를 남긴다.
export function dailyValues(rows: Record<string, unknown>[]) {
  const byDate = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const date = row[DATE_FIELD];
    if (typeof date !== 'string' || !/^\d{8}$/.test(date)) continue;
    byDate.set(date, [...(byDate.get(date) ?? []), row]);
  }
  const days: { basDt: string; values: Record<string, number> }[] = [];
  const problems: { basDt: string; reason: string }[] = [];
  let skippedFields = 0;
  for (const basDt of [...byDate.keys()].sort()) {
    const dayRows = byDate.get(basDt) ?? [];
    if (dayRows.length !== 1) {
      problems.push({ basDt, reason: `multiple_rows_per_day:${dayRows.length}` });
      continue;
    }
    const { values, skipped } = numericFields(dayRows[0]!);
    skippedFields += skipped;
    if (Object.keys(values).length === 0) problems.push({ basDt, reason: 'no_numeric_fields' });
    else days.push({ basDt, values });
  }
  return { days, problems, skippedFields, rowsWithoutDate: rows.length - [...byDate.values()].reduce((sum, list) => sum + list.length, 0) };
}
