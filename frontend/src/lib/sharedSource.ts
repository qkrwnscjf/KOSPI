// 여러 구독자가 자원 하나(타이머·감시자)를 함께 쓰는 저장소 (plan.md FQA-02 · 13, T-193 · T-196)
// React의 useSyncExternalStore에 넘길 subscribe를 만든다. 첫 구독자가 생기면 start로 자원을 만들고, 마지막 구독자가 떠나면 정리한다.
// 테스트할 수 있도록 React와 분리한 순수 모듈이다(`@/` 별칭 없음).

export function createSharedSource(start: (notify: () => void) => () => void) {
  const listeners = new Set<() => void>()
  let stop: (() => void) | undefined
  const notify = () => listeners.forEach(listener => listener())
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (!stop) stop = start(notify)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && stop) {
          stop()
          stop = undefined
        }
      }
    },
    size: () => listeners.size,
  }
}

// 앱 전체가 함께 쓰는 시계 (FQA-02, T-193). 예전에는 카드마다 1초 타이머가 따로 돌아, 카드 수만큼 따로 다시 그렸다.
// 시계 하나가 같은 순간에 모든 구독자에게 알리므로 React가 한 번에 묶어 그린다.
export function createClock(intervalMs: number, now: () => number = () => Date.now()) {
  let current = now()
  const source = createSharedSource(notify => {
    current = now()
    const handle = setInterval(() => {
      current = now()
      notify()
    }, intervalMs)
    return () => clearInterval(handle)
  })
  return { subscribe: source.subscribe, getSnapshot: () => current, size: source.size }
}

// 알림 간격 제한 (FQA-01, T-192): 자주 바뀌는 값(마지막 수신 시각)을 intervalMs에 한 번만 알린다.
// 간격 안에 다시 바뀌면 간격이 끝날 때 한 번 더 알려 마지막 값이 늦게라도 화면에 남게 한다.
export function createThrottledNotifier(notify: () => void, intervalMs: number, now: () => number = () => Date.now()) {
  let lastAt = -Infinity
  let pending: ReturnType<typeof setTimeout> | undefined
  return () => {
    const at = now()
    if (at - lastAt >= intervalMs) {
      lastAt = at
      notify()
      return
    }
    if (pending !== undefined) return
    pending = setTimeout(() => {
      pending = undefined
      lastAt = now()
      notify()
    }, intervalMs - (at - lastAt))
  }
}
