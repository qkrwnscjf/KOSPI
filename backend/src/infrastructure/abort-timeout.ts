// 시간 제한 + 실제 요청 중단 (docs/Task_ORDER.md T-150, BENCHMARK B-57)
// 결과만 버리면 멈춘 요청이 라이브러리 큐와 연결을 계속 차지하므로, AbortSignal로 요청 자체를 끊는다.

export class TimeoutError extends Error {}

export function withAbortTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => clearTimeout(timer));
}
