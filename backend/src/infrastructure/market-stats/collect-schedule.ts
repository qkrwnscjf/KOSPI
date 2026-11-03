// 증시 자금 흐름 수집 다음 주기 계산 (docs/Task_ORDER.md T-137, D-81)
// 순수 함수만 둔다(테스트 대상). market-stats-collector가 주기마다 부른다.
// - 키·권한·한도 문제(pause)면 하루 멈춘다.
// - 시간 제한·네트워크 같은 일시 실패는 첫 번째에 한해 30분 뒤 다시 시도한다(이전: 한 번만 실패해도 12시간 뒤).
//   그다음부터는 주기를 2배씩 늘린다(12시간 → 24시간).

export const RETRY_AFTER_ERROR_MS = 30 * 60_000;

export function nextCollectDelay(results: ('ok' | 'pause' | 'error')[], previousFailures: number, intervalMs: number, maxDelayMs: number) {
  if (results.includes('pause')) return { delayMs: maxDelayMs, failures: previousFailures };
  if (results.includes('error')) {
    const failures = previousFailures + 1;
    const delayMs = failures === 1 ? RETRY_AFTER_ERROR_MS : Math.min(intervalMs * 2 ** (failures - 1), maxDelayMs);
    return { delayMs, failures };
  }
  return { delayMs: intervalMs, failures: 0 };
}
