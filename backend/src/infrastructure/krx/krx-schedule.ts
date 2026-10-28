// KRX 최근 날짜 확인 일정 (docs/Task_ORDER.md T-132, D-75)
// 순수 함수만 둔다(테스트 대상). krx-collector가 주기마다 부른다.
//
// 이전에는 30분마다 최근 7일(평일 6일) × 지수 2개 + 최근 3일 × 시장 폭 2개 = 주기당 약 18회를 하루 종일 다시 받았다(하루 약 860회).
// 일별 값은 하루 한 번 생기므로, 날짜마다 상태를 기억해서 필요한 날짜만 받는다.
// - 기준일 D는 D 18:00 KST부터 확인한다. KRX 일별 값은 장 마감 뒤에 공개된다(관찰: D 17시, D+1 01시 40분에도 비어 있음 — B-44, B-46).
// - 이미 받은 날짜는 정정 반영을 위해 20시간 뒤 한 번만 다시 받는다.
// - 아직 비어 있는 날짜는 1시간에 한 번만 다시 확인한다. 뒤 날짜가 이미 받아졌다면 그 날은 휴장일이라 더 확인하지 않는다.
// - 상태는 프로세스 메모리에만 있다. 다시 시작하면 첫 주기에 공개된 날짜를 한 번씩 받는다(이전 주기 1회분과 같음).

export const CHECK_FROM_HOUR_KST = 18;
export const EMPTY_RECHECK_MS = 60 * 60_000;
export const RECHECK_AFTER_MS = 20 * 3600_000;

export interface DateCheckState { receivedAt?: number; recheckedAt?: number; lastEmptyAt?: number }

// 기준일(YYYYMMDD) 18:00 KST = 09:00 UTC
const checkFromMs = (basDd: string) =>
  Date.UTC(Number(basDd.slice(0, 4)), Number(basDd.slice(4, 6)) - 1, Number(basDd.slice(6, 8)), CHECK_FROM_HOUR_KST - 9);

// 이번 주기에 받을 날짜 (dates는 오래된 날부터)
export function datesToCheck(dates: string[], states: ReadonlyMap<string, DateCheckState>, nowMs: number): string[] {
  return dates.filter((date, index) => {
    if (nowMs < checkFromMs(date)) return false;
    const state = states.get(date);
    if (state?.receivedAt !== undefined) return state.recheckedAt === undefined && nowMs - state.receivedAt >= RECHECK_AFTER_MS;
    if (dates.slice(index + 1).some(later => states.get(later)?.receivedAt !== undefined)) return false;
    return state?.lastEmptyAt === undefined || nowMs - state.lastEmptyAt >= EMPTY_RECHECK_MS;
  });
}

// 받은 결과를 날짜 상태에 반영한다 (실패는 반영하지 않아 다음 주기에 다시 받는다)
export function recordCheck(state: DateCheckState | undefined, result: 'rows' | 'empty', nowMs: number): DateCheckState {
  const next: DateCheckState = { ...state };
  if (next.receivedAt !== undefined) next.recheckedAt = nowMs;
  else if (result === 'rows') next.receivedAt = nowMs;
  else next.lastEmptyAt = nowMs;
  return next;
}
