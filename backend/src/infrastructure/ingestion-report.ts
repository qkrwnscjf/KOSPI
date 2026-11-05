import { randomUUID } from 'node:crypto';
import type { Producer } from 'kafkajs';
import { TOPICS } from './kafka.js';
import { Counter } from './metrics.js';
import { safeKind, type IngestionRun } from '../shared/ingestion-runs.js';

// 적재 실행 기록 보내기 (docs/Task_ORDER.md T-118). 기록은 부가 기능이라 실패해도 수집을 막지 않고 예외를 던지지 않는다.
const reportsTotal = new Counter('kospi_ingestion_run_reports_total', 'Ingestion run reports sent to Kafka by result (sent / failed)');

export type RunReport = Partial<Pick<IngestionRun, 'targetFrom' | 'targetTo' | 'errorKind' | 'sourceTotal' | 'covered' | 'dropped'>>
  & Pick<IngestionRun, 'source' | 'endpoint' | 'received' | 'sent' | 'status' | 'startedAt'>;

// YYYYMMDD → YYYY-MM-DD
export const isoDate = (yyyymmdd: string) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

export async function reportRun(producer: Producer, report: RunReport) {
  const dropped = Object.fromEntries(Object.entries(report.dropped ?? {}).filter(([, count]) => count > 0));
  const run: IngestionRun = {
    runId: randomUUID(),
    source: report.source,
    endpoint: report.endpoint,
    targetFrom: report.targetFrom ?? null,
    targetTo: report.targetTo ?? null,
    received: report.received,
    sent: report.sent,
    dropped,
    status: report.status,
    errorKind: report.errorKind === undefined || report.errorKind === null ? null : safeKind(report.errorKind),
    sourceTotal: report.sourceTotal ?? null,
    covered: report.covered ?? null,
    startedAt: report.startedAt,
    finishedAt: Date.now(),
  };
  try {
    await producer.send({ topic: TOPICS.ingestionRuns, messages: [{ key: run.source, value: JSON.stringify(run) }] });
    reportsTotal.inc({ result: 'sent' });
  } catch {
    reportsTotal.inc({ result: 'failed' });
    console.warn(`Ingestion run report failed for ${run.source}`);
  }
}
