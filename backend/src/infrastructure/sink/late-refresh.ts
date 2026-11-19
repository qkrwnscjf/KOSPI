// 늦게 들어온 원본 tick의 5분 봉 보정 (docs/Task_ORDER.md T-128, D-74)
// 순수 함수만 둔다(테스트 대상). 실제 갱신 호출은 db-sink가 한다.
//
// 문제: 5분 봉 갱신 정책은 최근 2시간만 다시 계산한다(start_offset 2h). db-sink가 2시간 넘게 밀렸다가 돌아오면,
//       그 사이 원본 tick은 저장되지만 갱신 범위 밖이라 5분 봉(→ 1시간·1일 봉)에 반영되지 않고, 원본은 3시간 뒤 지워진다.
// 보정: 저장한 원본 중 가장 오래된 시각이 갱신 범위보다 앞서면, 그 구간만 5분 봉을 직접 다시 계산한다.
// 안전 조건(저장 불변 조건): 원본이 남아 있는 구간만 다시 계산한다. 원본은 3시간 보관(1시간 청크)이라 최근 3시간은 항상 있으므로,
//       여유 10분을 두고 2시간 50분보다 오래된 구간은 다시 계산하지 않는다(그 구간을 다시 계산하면 원본이 없어 집계가 지워짐).
// 1시간 봉(최근 2일)·1일 봉(최근 7일) 갱신 정책은 범위가 넓어서 다시 계산된 5분 봉을 다음 실행 때 스스로 반영한다.

export const POLICY_START_OFFSET_MS = 2 * 3600_000;      // 5분 봉 갱신 정책의 start_offset (마이그레이션 3)
export const SAFE_RAW_WINDOW_MS = (2 * 60 + 50) * 60_000; // 원본이 확실히 남아 있는 범위 (보관 3시간 − 여유 10분)
const BUCKET_MS = 5 * 60_000;

export interface RefreshWindow { start: number; end: number }

const floorBucket = (ms: number) => Math.floor(ms / BUCKET_MS) * BUCKET_MS;
const ceilBucket = (ms: number) => Math.ceil(ms / BUCKET_MS) * BUCKET_MS;

// 새로 저장한 원본 중 가장 오래된 시각 → 다시 계산할 구간과, 원본이 이미 지워졌을 수 있어 보정할 수 없는 행이 있는지.
// - 정책 범위(최근 2시간) 안이면 정책이 처리하므로 구간 없음.
// - 구간 시작은 안전 범위(2시간 50분) 안으로 자르고 5분 경계로 올린다. 끝은 정책 범위의 시작보다 한 버킷 뒤(겹쳐도 같은 값).
export function planLateRefresh(oldestInsertedMs: number, nowMs: number): { window: RefreshWindow | null; unrecoverable: boolean } {
  const policyStart = nowMs - POLICY_START_OFFSET_MS;
  if (oldestInsertedMs >= policyStart) return { window: null, unrecoverable: false };
  const safeStart = ceilBucket(nowMs - SAFE_RAW_WINDOW_MS);
  const unrecoverable = oldestInsertedMs < safeStart;
  const start = Math.max(floorBucket(oldestInsertedMs), safeStart);
  const end = floorBucket(policyStart) + BUCKET_MS;
  return { window: start < end ? { start, end } : null, unrecoverable };
}

// 기다리는 동안 합쳐 둔 구간을 실행 직전에 다시 안전 범위 안으로 자른다(기다리는 사이 시간이 흘러 원본이 지워졌을 수 있음)
export function clampWindow(window: RefreshWindow, nowMs: number): RefreshWindow | null {
  const start = Math.max(window.start, ceilBucket(nowMs - SAFE_RAW_WINDOW_MS));
  return start < window.end ? { start, end: window.end } : null;
}

export const mergeWindows = (a: RefreshWindow | null, b: RefreshWindow): RefreshWindow =>
  a ? { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) } : b;

// 첫 과거 채우기(backfill.ts runBackfillOnce)의 집계 재계산 범위 (plan.md QA-08 / P2-2, T-179)
// - 빈 DB(원본보다 오래된 집계가 없음): 넣은 과거 봉을 집계에 반영하려면 전체를 다시 계산해야 한다(원래 동작).
// - 이미 운영한 DB(첫 시도가 실패한 뒤 며칠 돌다가 다시 시도하는 경우): 전체를 다시 계산하면 원본이 지워진 과거 버킷이
//   방금 넣은 과거 봉만으로 다시 만들어져 그동안의 실시간 집계가 사라진다(저장 불변 조건). 그래서 전체 재계산을 하지 않고 갱신 정책에 맡긴다.
//   이 경우 넣은 과거 봉은 집계에 들어가지 않고 원본 보관 기간 뒤 지워지며, 그래프는 일봉 표·채운 봉(T-104, T-127, T-151)이 메운다.
// 판단은 과거 봉을 넣기 전에 한다(넣은 뒤에는 실시간 집계가 새 원본을 읽어 "집계가 있다"로 보일 수 있음).
export type BackfillRefreshScope = 'full' | 'policy_only';
export const backfillRefreshScope = (hasAggregatesOlderThanRaw: boolean): BackfillRefreshScope =>
  hasAggregatesOlderThanRaw ? 'policy_only' : 'full';
