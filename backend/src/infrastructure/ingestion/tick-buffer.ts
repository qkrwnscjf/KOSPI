// Kafka 전송 실패 때 틱 버퍼 (plan.md QA-13 / P2-6, docs/Task_ORDER.md T-218, BENCHMARK B-90, D-96 결정 2)
// 예전에는 Kafka가 멈춘 동안 받은 틱을 보내지 못하고 버렸다(Yahoo는 최신값만 주므로 되찾을 수 없음).
// 실패한 틱을 메모리에 모았다가 다음 주기에 새 틱보다 먼저 보낸다. 순서는 수집 순서 그대로다.
// 상한: 최근 maxAgeMs 안에 수집한 것, 최대 maxCount개. 넘으면 오래된 것부터 버리고 버린 수를 돌려준다(지표로 셈).
// 프로세스가 끝나면 버퍼도 사라진다(디스크에 쓰지 않음).

export const TICK_BUFFER_LIMITS = { maxAgeMs: 10 * 60_000, maxCount: 5_000 } as const;

export function createTickBuffer<T extends { collectedAt?: number | undefined }>(limits: { maxAgeMs: number; maxCount: number } = TICK_BUFFER_LIMITS) {
  let items: T[] = [];
  // 상한을 넘는 오래된 것을 앞에서부터 버린다. 수집 시각이 없는 항목은 나이로는 버리지 않는다
  const trim = (nowMs: number) => {
    const before = items.length;
    items = items.filter(item => item.collectedAt === undefined || nowMs - item.collectedAt <= limits.maxAgeMs);
    if (items.length > limits.maxCount) items = items.slice(items.length - limits.maxCount);
    return before - items.length;
  };
  return {
    size: () => items.length,
    // 보낼 것을 모두 꺼낸다(버퍼는 비워짐). 보내지 못하면 restore로 되돌린다
    drain(): T[] {
      const out = items;
      items = [];
      return out;
    },
    // 보내지 못한 묶음을 (기존 버퍼보다 앞에) 되돌리고 상한을 적용한다. 버린 수를 돌려준다
    restore(batch: readonly T[], nowMs: number): number {
      items = [...batch, ...items];
      return trim(nowMs);
    },
  };
}
