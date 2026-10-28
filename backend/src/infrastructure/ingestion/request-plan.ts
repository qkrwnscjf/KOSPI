// Yahoo 요청 심볼 고르기 (docs/Task_ORDER.md T-131, D-75)
// 순수 함수만 둔다(테스트 대상). worker가 주기마다 부른다.
//
// 이전에는 시장 하나만 열려 있어도 27종 전부를 5초마다 요청했다. 닫힌 시장의 지표는 소스 시각이 바뀌지 않아 전송되지도 않는다.
// 이제는 열린 시장(+ 휴장 판단 중인 시장, 방금 닫힌 시장)의 지표만 요청하고, 전체는 60초마다 한 번 요청한다.
// - 휴장(holiday) 시장도 요청한다: 소스 장 상태가 바뀌어야 개장을 알아챌 수 있다(T-56). 빼면 개장 판단이 최대 60초 늦어진다.
// - 방금 닫힌 시장은 30분 동안 요청한다: 장 마감 뒤 종가·장 상태가 몇 분 늦게 확정되는 경우를 받기 위함.
// - 전체 요청(60초)은 유휴 주기와 같은 간격이다. 모든 시장이 닫혀 있으면 매번 전체를 요청한다(이전과 같음).

import { YAHOO_KEYS, type YahooSymbolKey } from '../../shared/symbols.js';
import { YAHOO_MARKET, type MarketId, type MarketStatus } from './market-hours.js';

export const FULL_REFRESH_MS = 60_000;
export const CLOSE_GRACE_MS = 30 * 60_000;

export function planYahooRequest(
  statuses: Partial<Record<MarketId, MarketStatus>>,
  closedAt: ReadonlyMap<MarketId, number>,
  lastFullAt: number | undefined,
  nowMs: number
): { keys: YahooSymbolKey[]; full: boolean } {
  if (lastFullAt === undefined || nowMs - lastFullAt >= FULL_REFRESH_MS) return { keys: [...YAHOO_KEYS], full: true };
  const keys = YAHOO_KEYS.filter(key => {
    const market = YAHOO_MARKET[key];
    const status = statuses[market];
    if (status === undefined || status !== 'closed') return true;
    const closed = closedAt.get(market);
    return closed !== undefined && nowMs - closed < CLOSE_GRACE_MS;
  });
  // 요청할 지표가 없으면(모두 닫힘) 전체를 요청한다. 빈 요청을 "실패"로 세어 백오프하지 않게 하기 위함
  return keys.length === 0 ? { keys: [...YAHOO_KEYS], full: true } : { keys, full: false };
}
