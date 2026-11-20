// 실시간 수신·재연결 판단 (plan.md QA-32 / P4-2, docs/Task_ORDER.md T-215, BENCHMARK B-87)
// 테스트할 수 있도록 React·소켓과 분리한 순수 함수다. 다른 모듈을 import하지 않는다(`@/` 별칭 없음).

// "마지막 데이터 수신"을 바꿀 tick인지: 그 지표에서 이미 받은 값보다 소스 시각이 새로운 tick만.
// 구독할 때 서버가 보내 주는 캐시값(지표의 첫 tick)이나, 다시 구독할 때 받은 같은 값은 새로 받은 데이터가 아니다.
// 예전에는 이런 값으로도 시각이 바뀌어, worker가 멈춰 있어도 탭을 옮길 때마다 "방금 수신"으로 보였다
export function isNewerTick(previous: { timestamp: number } | undefined, tick: { timestamp: number }) {
  return previous !== undefined && tick.timestamp > previous.timestamp
}

// 재연결 때 다시 받을 쿼리(앞부분이 같은 쿼리 모두): 실시간 그래프 첫 화면, 최근 공시(끊긴 동안 온 새 공시는 소켓으로 다시 오지 않음)
export const RECONNECT_REFETCH_KEYS: readonly (readonly string[])[] = [['recent'], ['disclosures', 'recent']]

// 다시 연결됐는지: 한 번 연결된 뒤 끊겼다가 다시 연결될 때만 true.
// 예전에는 처음 연결(connecting → connected)도 재연결로 보아, 실시간 차트 캐시를 모두 무효화해 다시 받았다
export function createReconnectDetector(initiallyConnected: boolean) {
  let connected = initiallyConnected
  let hadConnection = initiallyConnected
  return (nowConnected: boolean) => {
    const reconnected = nowConnected && !connected && hadConnection
    if (nowConnected) hadConnection = true
    connected = nowConnected
    return reconnected
  }
}
