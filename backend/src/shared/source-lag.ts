// 소스 지연 측정 (docs/Task_ORDER.md T-162, BENCHMARK B-66)
// 화면의 "지연 N분" 배지를 카드 목록의 고정값 대신 실제 측정값으로 보여 주기 위한 순수 함수다(테스트 대상).
// 지연 = worker 수집 시각(collectedAt) − 소스 시각(timestamp). 두 값 모두 서버 쪽 시각이라 브라우저 시계와 무관하다.
// - 그 지표의 시장이 시간표상 열려 있을 때 수집한 틱만 쓴다. 장 마감 뒤 몇 시간 늦게 들어오는 틱(B-62 관찰)이나
//   장 상태만 바뀌어 다시 보낸 지난 틱은 지연이 아니라 "오래된 값"이라 뺀다.
// - 3시간을 넘는 값도 뺀다(공휴일처럼 시간표는 열려 있지만 소스가 닫힌 날의 지난 틱).
// - 최근 LAG_WINDOW개의 중앙값을 쓴다. 한두 개의 튀는 값에 흔들리지 않게 하기 위함이다.

export const LAG_WINDOW = 30;
export const MIN_LAG_SAMPLES = 5;
export const MAX_LAG_MS = 3 * 60 * 60 * 1000;

export interface SourceLag {
  lagSeconds: number; // 최근 표본의 중앙값(초)
  samples: number;    // 중앙값에 쓴 표본 수
  measuredAt: number; // 측정값을 남긴 시각(ms)
}

export const isLagSample = (lagMs: number, marketOpen: boolean) =>
  marketOpen && Number.isFinite(lagMs) && lagMs >= 0 && lagMs <= MAX_LAG_MS;

// 표본을 뒤에 붙이고 최근 window개만 남긴다 (원본 배열은 바꾸지 않음)
export function pushLagSample(samples: readonly number[], lagMs: number, window = LAG_WINDOW): number[] {
  const next = [...samples, lagMs];
  return next.length > window ? next.slice(next.length - window) : next;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// 표본이 충분하면 저장할 측정값을 만든다
export function summarizeLag(samples: readonly number[], nowMs: number, minSamples = MIN_LAG_SAMPLES): SourceLag | null {
  if (samples.length < minSamples) return null;
  const value = median(samples);
  return value === null ? null : { lagSeconds: Math.round(value / 1000), samples: samples.length, measuredAt: nowMs };
}

// 캐시에서 읽은 값 검증 (형식이 맞지 않으면 버린다)
export function parseSourceLag(value: unknown): SourceLag | null {
  if (!value || typeof value !== 'object') return null;
  const { lagSeconds, samples, measuredAt } = value as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return ok(lagSeconds) && ok(samples) && ok(measuredAt) ? { lagSeconds, samples, measuredAt } : null;
}
