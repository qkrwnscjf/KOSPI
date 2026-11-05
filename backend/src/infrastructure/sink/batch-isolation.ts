// DB가 거부한 값 격리 (docs/Task_ORDER.md T-154, BENCHMARK B-62)
// 검증을 통과한 메시지를 DB가 거부하면 같은 묶음을 계속 다시 시도해서, 컨슈머 하나를 함께 쓰는 모든 토픽의 저장이 멈췄다.
// 값 오류면 메시지를 한 건씩 다시 저장해 보고, 그래도 거부되는 메시지만 DLQ로 보낸다. 연결 오류 같은 나머지는 그대로 던져 다시 시도한다(오프셋 확정 안 함).

import type { EachBatchPayload, KafkaMessage } from 'kafkajs';

// SQLSTATE 21(cardinality, 같은 키를 한 문장에서 두 번 갱신), 22(값 오류), 23(제약 위반)
export const isDataError = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^(21|22|23)/.test(code);
};

export const dataErrorCode = (error: unknown) => String((error as { code?: unknown }).code);

type Handler = (payload: EachBatchPayload) => Promise<void>;
type OnRejected = (message: KafkaMessage, code: string) => Promise<void>;

export async function runIsolated(payload: EachBatchPayload, handler: Handler, onRejected: OnRejected) {
  try {
    await handler(payload);
    return;
  } catch (error) {
    if (!isDataError(error)) throw error;
  }
  // 잘못된 메시지를 묶음에서 찾는다. 앞 시도에서 형식 오류 메시지가 이미 DLQ에 들어갔다면 한 번 더 들어갈 수 있다(다시 처리 도구가 원본 위치로 중복을 거른다).
  const { batch, resolveOffset, heartbeat } = payload;
  for (const message of batch.messages) {
    try {
      await handler({ ...payload, batch: { ...batch, messages: [message] } as EachBatchPayload['batch'] });
    } catch (error) {
      if (!isDataError(error)) throw error;
      await onRejected(message, dataErrorCode(error));
      resolveOffset(message.offset);
    }
    await heartbeat();
  }
}
