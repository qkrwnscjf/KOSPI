// worker 상태 점검·주기 로그 요약 (plan.md QA-23 · 29 / P3-2 · P3-5, docs/Task_ORDER.md T-212 · T-214, BENCHMARK B-85 · B-86)
// 시험할 수 있도록 worker.ts에서 분리한 순수 함수다.

// 장중에 Yahoo 수집이 연속으로 이 횟수만큼 실패하면 상태 점검 'yahoo_fetch'를 실패로 본다.
// 백오프(5초 × 2배, 상한 60초) 기준으로 약 3분이다. 그 뒤 '서비스 상태 점검 실패' 알림(5분)이 울린다
export const YAHOO_UNHEALTHY_FAILURES = 5;

// 예전에는 Yahoo가 막혀도 수집 루프가 돌기만 하면 healthy였다(QA-23). 장이 모두 닫혀 있으면 실패가 이어져도 정상으로 본다(받을 새 값이 없음)
export const yahooFetchHealthy = (consecutiveFailures: number, anyMarketOpen: boolean, limit = YAHOO_UNHEALTHY_FAILURES) =>
  !anyMarketOpen || consecutiveFailures < limit;

export interface CycleCounts {
  received: number; // Yahoo에서 받은 항목
  fresh: number; // 소스 시각이 바뀐 새 tick
  sent: number; // Kafka로 보낸 tick
  failed: boolean; // Yahoo 수집 실패(빈 응답 포함)
}

// 수집 주기마다 2 ~ 3줄씩 남기던 로그(5초 주기면 1분에 약 25줄, QA-29)를 intervalMs마다 한 줄 요약으로 바꾼다.
// add()가 요약 줄을 돌려줄 때만 로그를 남긴다. 장 상태·요청 대상·백오프·오류 줄은 바뀔 때마다 그대로 남는다
export function createCycleSummary(intervalMs = 60_000, now: () => number = Date.now) {
  let startedAt = now();
  let totals = { cycles: 0, failed: 0, received: 0, fresh: 0, sent: 0 };
  return {
    add(counts: CycleCounts): string | null {
      totals = {
        cycles: totals.cycles + 1,
        failed: totals.failed + (counts.failed ? 1 : 0),
        received: totals.received + counts.received,
        fresh: totals.fresh + counts.fresh,
        sent: totals.sent + counts.sent,
      };
      const elapsed = now() - startedAt;
      if (elapsed < intervalMs) return null;
      const line = `Cycles in the last ${Math.round(elapsed / 1000)}s: ${totals.cycles} (failed ${totals.failed}), items received ${totals.received}, new ticks ${totals.fresh}, sent ${totals.sent}`;
      startedAt = now();
      totals = { cycles: 0, failed: 0, received: 0, fresh: 0, sent: 0 };
      return line;
    },
  };
}
