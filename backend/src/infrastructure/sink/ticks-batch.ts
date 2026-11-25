// 시세 묶음 저장 (docs/Task_ORDER.md T-12, T-15, T-185, T-230, BENCHMARK B-106)
// db-sink.ts는 불러오면 바로 Kafka·DB에 붙어 실행되므로, 통합 시험(test-integration/)이 운영 함수를 그대로 쓸 수 있도록 떼어 냈다.
// 처리 순서와 SQL은 그대로다: 메시지 검증 → 잘못된 메시지는 넘겨받은 처리(DLQ) → 한 번에 INSERT(중복은 유니크 키로 건너뜀)
// → 저장이 끝난 뒤에만 마지막 오프셋 확정(at-least-once). 지표·로그·늦은 데이터 보정은 db-sink가 넘겨준다.
import type { EachBatchPayload, KafkaMessage } from 'kafkajs';
import { parseTick } from '../../shared/tick-validation.js';
import type { TickData } from '../../shared/types.js';
import { chunkForParams } from './sql-chunks.js';

type Query = (text: string, values: unknown[]) => Promise<{ rowCount: number | null; rows: { ms: number }[] }>;

export interface StoredTicks {
  valid: TickData[];
  inserted: number;
  times: number[]; // 실제로 들어간 행의 시각(늦은 데이터 보정용, T-128)
  startedAt: number;
  committedAt: number;
}

export interface TicksBatchDeps {
  query: Query;
  onInvalid: (message: KafkaMessage, reason: string, source: { topic: string; partition: number }) => Promise<void>;
  onStored: (result: StoredTicks) => void;
  onInsertError: (rows: number, error: unknown, startedAt: number) => void;
}

// 여러 행을 INSERT 한 번으로 저장한다 (P-16). 단일 문장이라 전부 들어가거나 전부 실패한다.
// 나머지는 유니크 제약에 걸려 건너뛴 중복이다 (T-15). 매개변수 한도를 넘지 않게 나눠 넣는다 (QA-05 / P1-6, T-185)
export async function insertTicks(query: Query, ticks: TickData[]) {
  let inserted = 0;
  const times: number[] = [];
  for (const chunk of chunkForParams(ticks, 7)) {
    const values: unknown[] = [];
    const rows = chunk.map((tick, index) => {
      const base = index * 7;
      values.push(tick.timestamp, tick.symbol, tick.category, tick.price, tick.changeRate, tick.changePrice, tick.volume ?? null);
      return `(to_timestamp($${base + 1} / 1000.0), $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    const result = await query(
      `INSERT INTO market_ticks (time, symbol, category, price, change_rate, change_price, volume) VALUES ${rows.join(', ')}
       ON CONFLICT (symbol, time) DO NOTHING
       RETURNING (extract(epoch FROM time) * 1000)::float8 AS ms`,
      values
    );
    inserted += result.rowCount ?? 0;
    for (const row of result.rows) times.push(row.ms);
  }
  return { inserted, times };
}

// 시세 묶음 처리 (T-12, T-15). 잘못된 메시지는 넘겨받은 처리(DLQ), 저장에 성공한 뒤에만 오프셋 확정
export function createTicksBatchHandler(deps: TicksBatchDeps) {
  return async function handleTicksBatch({ batch, resolveOffset, heartbeat }: EachBatchPayload) {
    const valid: TickData[] = [];
    for (const message of batch.messages) {
      const parsed = parseTick(message.value);
      // change_price 컬럼은 NOT NULL이라, 없으면 묶음 전체가 계속 실패한다. 그래서 DLQ로 보낸다.
      const reason = !parsed.ok ? parsed.reason : parsed.tick.changePrice === undefined ? 'change_price_missing' : undefined;
      if (reason || !parsed.ok) {
        await deps.onInvalid(message, reason ?? 'unknown', { topic: batch.topic, partition: batch.partition });
        continue;
      }
      valid.push(parsed.tick);
    }

    if (valid.length > 0) {
      const startedAt = Date.now();
      let result: { inserted: number; times: number[] };
      try {
        result = await insertTicks(deps.query, valid);
      } catch (error) {
        // 예외를 던져서 오프셋을 확정하지 않는다. 값 오류면 runIsolated가 한 건씩 나눠 저장하고, 결정적 오류가 3번 반복되면 한 건씩 나눠 본다(T-210).
        // 연결 같은 일시적 오류는 kafkajs가 같은 묶음을 다시 시도한다.
        deps.onInsertError(valid.length, error, startedAt);
        throw error;
      }
      deps.onStored({ valid, inserted: result.inserted, times: result.times, startedAt, committedAt: Date.now() });
    }

    const lastMessage = batch.messages[batch.messages.length - 1];
    if (lastMessage) resolveOffset(lastMessage.offset);
    await heartbeat();
  };
}
