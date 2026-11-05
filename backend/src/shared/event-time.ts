// 메시지 시각 범위 검사 (docs/Task_ORDER.md T-154, BENCHMARK B-62)
// 숫자이기만 하면 통과시키면 범위 밖 시각에서 to_timestamp가 실패하고, db-sink가 같은 묶음을 계속 다시 시도한다.
// 위 한계에 여유를 두는 이유: 시계 차이와 일별 값의 기준 시각(그날 15:30 KST)을 막지 않기 위함이다. 이상한 날짜 표시는 품질 검사(date_label)가 잡는다.

const MIN_EVENT_TIME_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_MS = 36 * 3600_000;

export const isPlausibleEventTime = (value: unknown, nowMs = Date.now()): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= MIN_EVENT_TIME_MS && value <= nowMs + MAX_FUTURE_MS;
