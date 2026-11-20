// DB가 거부한 값 격리 (docs/Task_ORDER.md T-154, BENCHMARK B-62)
// 검증을 통과한 메시지를 DB가 거부하면 같은 묶음을 계속 다시 시도해서, 컨슈머 하나를 함께 쓰는 모든 토픽의 저장이 멈췄다.
// 값 오류면 메시지를 한 건씩 다시 저장해 보고, 그래도 거부되는 메시지만 DLQ로 보낸다. 연결 오류 같은 나머지는 그대로 던져 다시 시도한다(오프셋 확정 안 함).
//
// 반복 오류 (plan.md QA-05 / P1-6 나머지, T-210, BENCHMARK B-83)
// 값 오류가 아니어도 다시 시도해서 바뀌지 않는(결정적인) DB 오류가 있다(SQLSTATE 42 문장·권한, 0A 미지원 등).
// 그런 오류로 같은 묶음이 REPEAT_LIMIT번 실패하면 한 건씩 저장해 본다. 일부라도 저장되면 실패한 메시지만 DLQ로 보내고,
// 모두 실패하면 메시지 문제가 아니라 코드·스키마 문제로 보고 DLQ 없이 계속 다시 시도한다(정상 메시지를 DLQ로 버리지 않게).
// 연결·자원·운영자 개입·동시성·시스템 오류와 SQLSTATE가 없는 오류(네트워크, 시간 초과)는 일시적이라 몇 번이든 DLQ로 보내지 않는다.

import type { EachBatchPayload, KafkaMessage } from 'kafkajs';

const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

// SQLSTATE 21(cardinality, 같은 키를 한 문장에서 두 번 갱신), 22(값 오류), 23(제약 위반),
// 54(한도 초과: 값이 너무 큼 등, T-210). 메시지 하나의 문제라 바로 한 건씩 저장해 본다
export const isDataError = (error: unknown) => /^(21|22|23|54)[0-9A-Z]{3}$/.test(errorCode(error) ?? '');

// 다시 시도해도 같은 결과인 비데이터 오류 (T-210): 0A 미지원 기능, 2B · 2D · 2F · 39 · 3B 트랜잭션·루틴, 42 문장·권한, 44 WITH CHECK, P0 PL/pgSQL
export const isRepeatableError = (error: unknown) => /^(0A|2B|2D|2F|39|3B|42|44|P0)[0-9A-Z]{3}$/.test(errorCode(error) ?? '');

export const dataErrorCode = (error: unknown) => String((error as { code?: unknown }).code);

// 같은 묶음이 이 횟수만큼 결정적 오류로 실패하면 한 건씩 저장해 본다
export const REPEAT_LIMIT = 3;

type Handler = (payload: EachBatchPayload) => Promise<void>;
type OnRejected = (message: KafkaMessage, code: string) => Promise<void>;

// 묶음별 연속 실패 횟수. 키는 토픽·파티션·첫 오프셋(kafkajs는 실패한 묶음을 같은 위치부터 다시 준다)
const repeatFailures = new Map<string, number>();
const MAX_TRACKED_BATCHES = 1_000;
const batchKey = ({ batch }: EachBatchPayload) => `${batch.topic}|${batch.partition}|${batch.messages[0]?.offset ?? ''}`;

export const resetRepeatFailures = () => repeatFailures.clear();

export async function runIsolated(payload: EachBatchPayload, handler: Handler, onRejected: OnRejected) {
  const key = batchKey(payload);
  try {
    await handler(payload);
    repeatFailures.delete(key);
    return;
  } catch (error) {
    if (isDataError(error)) {
      repeatFailures.delete(key);
      await isolateDataErrors(payload, handler, onRejected);
      return;
    }
    if (!isRepeatableError(error)) throw error;
    const failures = (repeatFailures.get(key) ?? 0) + 1;
    if (failures < REPEAT_LIMIT) {
      if (repeatFailures.size >= MAX_TRACKED_BATCHES) repeatFailures.clear();
      repeatFailures.set(key, failures);
      throw error;
    }
    repeatFailures.delete(key);
    console.warn(`DB sink batch ${payload.batch.topic}[${payload.batch.partition}]@${payload.batch.messages[0]?.offset ?? '?'} failed ${failures} times with ${dataErrorCode(error)}; storing messages one by one`);
    await isolateRepeatable(payload, handler, onRejected, error);
  }
}

const single = (payload: EachBatchPayload, message: KafkaMessage) =>
  ({ ...payload, batch: { ...payload.batch, messages: [message] } as EachBatchPayload['batch'] });

// 값 오류: 한 건씩 저장하고, 거부된 메시지는 바로 DLQ (T-154 그대로)
// 잘못된 메시지를 묶음에서 찾는다. 앞 시도에서 형식 오류 메시지가 이미 DLQ에 들어갔다면 한 번 더 들어갈 수 있다(다시 처리 도구가 원본 위치로 중복을 거른다).
async function isolateDataErrors(payload: EachBatchPayload, handler: Handler, onRejected: OnRejected) {
  const { batch, resolveOffset, heartbeat } = payload;
  for (const message of batch.messages) {
    try {
      await handler(single(payload, message));
    } catch (error) {
      if (!isDataError(error)) throw error;
      await onRejected(message, dataErrorCode(error));
      resolveOffset(message.offset);
    }
    await heartbeat();
  }
}

// 결정적 비데이터 오류: 한 건씩 저장하되, 모두 실패하는지 보기 전에는 오프셋을 확정하지 않는다.
// 일부라도 저장되면 실패한 메시지를 DLQ로 보낸 뒤 마지막 오프셋을 확정한다. 모두 실패하면 처음 오류를 던진다(DLQ 없음)
async function isolateRepeatable(payload: EachBatchPayload, handler: Handler, onRejected: OnRejected, firstError: unknown) {
  const { batch, resolveOffset, heartbeat } = payload;
  const deferred: EachBatchPayload = { ...payload, resolveOffset: () => undefined };
  const failed: { message: KafkaMessage; code: string }[] = [];
  for (const message of batch.messages) {
    try {
      await handler(single(deferred, message));
    } catch (error) {
      if (!isDataError(error) && !isRepeatableError(error)) throw error;
      failed.push({ message, code: dataErrorCode(error) });
    }
    await heartbeat();
  }
  if (failed.length === batch.messages.length) throw firstError;
  for (const { message, code } of failed) await onRejected(message, code);
  const lastMessage = batch.messages[batch.messages.length - 1];
  if (lastMessage) resolveOffset(lastMessage.offset);
}
