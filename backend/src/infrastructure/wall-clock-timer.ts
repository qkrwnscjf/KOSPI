// 실제 시각 기준 타이머 (docs/Task_ORDER.md T-140, BENCHMARK B-53)
// setTimeout은 PC 잠자기로 컨테이너가 멈춘 시간을 세지 않아, 긴 주기가 그만큼 밀린다(B-51: 73분 멈춤, B-52: 약 10분 지연).
// 정해진 시각을 기억해 두고 짧게 나눠 확인하므로, 깨어난 뒤 이미 지난 시각이면 다음 확인 때 바로 실행한다.
// 수집 주기처럼 분 단위 이상의 일정에만 쓴다.

export const WALL_CLOCK_CHECK_MS = 30_000;

export interface WallClockTimer { cancel: () => void }

export function setWallClockTimeout(callback: () => void, delayMs: number, now: () => number = Date.now, checkMs = WALL_CLOCK_CHECK_MS): WallClockTimer {
  const dueAt = now() + delayMs;
  let handle: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const check = () => {
    if (cancelled) return;
    const remaining = dueAt - now();
    if (remaining <= 0) {
      callback();
      return;
    }
    handle = setTimeout(check, Math.min(remaining, checkMs));
  };
  check();
  return {
    cancel: () => {
      cancelled = true;
      clearTimeout(handle);
    },
  };
}
