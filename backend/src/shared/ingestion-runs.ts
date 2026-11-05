// 적재 실행 기록 (docs/Task_ORDER.md T-118, BENCHMARK B-62)
// 수집 경로마다 "언제 어느 기간을 몇 건 받고 몇 건 보내고 몇 건 버렸는지"를 남긴다.
// 수집기는 DB에 직접 접속하지 않으므로 Kafka `ingestion-runs`를 거쳐 db-sink가 저장한다. Gateway는 읽지 않는다.
// URL·키·응답 원문·오류 원문은 넣지 않는다. 문자열 필드는 짧은 고정 형식만 받는다.

import { isPlausibleEventTime } from './event-time.js';

export const INGESTION_SOURCES = ['yahoo_quote', 'yahoo_chart', 'krx_index', 'krx_stock', 'dart', 'kofia'] as const;
export type IngestionSource = (typeof INGESTION_SOURCES)[number];
export const INGESTION_STATUSES = ['ok', 'empty', 'partial', 'error'] as const;
export type IngestionStatus = (typeof INGESTION_STATUSES)[number];

export interface IngestionRun {
  runId: string;
  source: IngestionSource;
  endpoint: string;              // 코드에 고정된 이름 (쿼리·키 없음)
  targetFrom: string | null;     // 대상 기간 YYYY-MM-DD
  targetTo: string | null;
  received: number;
  sent: number;
  dropped: Record<string, number>; // 사유별 버린 건수
  status: IngestionStatus;
  errorKind: string | null;      // 오류 종류 (오류 원문이 아님)
  sourceTotal: number | null;    // 소스가 알려 준 전체 건수(있을 때만)
  covered: number | null;        // 그중 수집기가 받은 건수
  startedAt: number;
  finishedAt: number;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENDPOINT = /^[A-Za-z0-9_./:-]{1,60}$/;
const KIND = /^[a-z0-9_]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COUNT = 2_000_000_000; // INTEGER 칼럼 범위 안
const MAX_REASONS = 20;

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
const isOptional = <T>(value: unknown, check: (input: unknown) => input is T): value is T | null => value === null || check(value);
const isDate = (value: unknown): value is string => typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const isKind = (value: unknown): value is string => typeof value === 'string' && KIND.test(value);

// 오류 종류·사유 이름을 고정 형식으로 바꾼다. 맞지 않으면 'other' (임의 문자열이 기록에 들어가지 않게)
export const safeKind = (value: unknown): string => (isKind(value) ? value : 'other');

export type IngestionRunParseResult = { ok: true; run: IngestionRun } | { ok: false; reason: string };
const fail = (reason: string): IngestionRunParseResult => ({ ok: false, reason });

// Kafka 메시지 검증 (db-sink). 예외를 던지지 않는다 (SEC-002)
export function parseIngestionRun(value: Buffer | null): IngestionRunParseResult {
  if (!value || value.length === 0) return fail('empty');
  let data: unknown;
  try {
    data = JSON.parse(value.toString());
  } catch {
    return fail('invalid_json');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return fail('not_object');
  const r = data as Record<string, unknown>;
  if (typeof r.runId !== 'string' || !RUN_ID.test(r.runId)) return fail('run_id');
  if (typeof r.source !== 'string' || !(INGESTION_SOURCES as readonly string[]).includes(r.source)) return fail('source');
  if (typeof r.endpoint !== 'string' || !ENDPOINT.test(r.endpoint)) return fail('endpoint');
  if (!isOptional(r.targetFrom, isDate) || !isOptional(r.targetTo, isDate)) return fail('target');
  if (!isCount(r.received) || !isCount(r.sent)) return fail('counts');
  if (typeof r.dropped !== 'object' || r.dropped === null || Array.isArray(r.dropped)) return fail('dropped');
  const reasons = Object.entries(r.dropped as Record<string, unknown>);
  if (reasons.length > MAX_REASONS || !reasons.every(([name, count]) => KIND.test(name) && isCount(count))) return fail('dropped');
  if (typeof r.status !== 'string' || !(INGESTION_STATUSES as readonly string[]).includes(r.status)) return fail('status');
  if (!isOptional(r.errorKind, isKind)) return fail('error_kind');
  if (!isOptional(r.sourceTotal, isCount) || !isOptional(r.covered, isCount)) return fail('coverage');
  if (!isPlausibleEventTime(r.startedAt) || !isPlausibleEventTime(r.finishedAt)) return fail('time');
  return {
    ok: true,
    run: {
      runId: r.runId,
      source: r.source as IngestionSource,
      endpoint: r.endpoint,
      targetFrom: r.targetFrom,
      targetTo: r.targetTo,
      received: r.received,
      sent: r.sent,
      dropped: r.dropped as Record<string, number>,
      status: r.status as IngestionStatus,
      errorKind: r.errorKind,
      sourceTotal: r.sourceTotal,
      covered: r.covered,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    },
  };
}
