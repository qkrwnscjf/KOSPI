// worker 수집 루프의 판단 규칙 (plan.md QA-42 / P6-2 축소, docs/Task_ORDER.md T-226, BENCHMARK B-100)
// 예전에는 worker.ts 안에 묶여 있어 시험할 수 없었다. 동작은 그대로 옮겼다. 시험: test/poll-policy.test.ts
import type { MarketState } from '../../shared/market-state.js';

export interface TickStamp {
  timestamp: number;
  marketState: MarketState | undefined;
}

export interface SentStamp {
  timestamp: number | undefined;
  marketState: MarketState | undefined;
}

// 변경 감지 (T-06, D-13, T-56): 마지막으로 보낸 소스 시각보다 새로운 tick만 보낸다.
// 시각이 바뀌었으면 가격이 같아도 새 tick이다. 장 상태가 바뀐 경우도 보낸다(화면의 장중/휴장 표시용).
// 장 상태가 없는 tick은 "바뀜"으로 보지 않는다. 처음 보는 지표는 보낸다. 검증 모드(sendUnchanged)는 모두 보낸다.
export function isFreshTick(tick: TickStamp, lastSent: SentStamp, sendUnchanged = false): boolean {
  if (sendUnchanged || lastSent.timestamp === undefined) return true;
  if (tick.timestamp > lastSent.timestamp) return true;
  return tick.marketState !== undefined && tick.marketState !== lastSent.marketState;
}

// 백오프 (T-04): Yahoo 수집이 연속 실패하면 대기를 2배씩 늘린다. 성공(실패 0회)이면 원래 주기.
// 상한은 max(최대 백오프, 지금 주기): 유휴 주기(60초)가 최대 백오프보다 길어도 백오프 때문에 짧아지지 않게 한다
export function backoffDelay(intervalMs: number, consecutiveFailures: number, maxBackoffMs: number): number {
  if (consecutiveFailures <= 0) return intervalMs;
  return Math.min(intervalMs * 2 ** consecutiveFailures, Math.max(maxBackoffMs, intervalMs));
}
