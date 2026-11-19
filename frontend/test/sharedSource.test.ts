// 공유 자원·알림 간격 (plan.md FQA-01 · 02 · 13, T-192 · T-193 · T-196, BENCHMARK B-78)
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createClock, createSharedSource, createThrottledNotifier } from '../src/lib/sharedSource.ts'

test('시계: 카드 17장이 구독해도 1초 타이머는 1개이고, 1초마다 한 번에 모두 알린다 (FQA-02)', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const intervalSpy = mock.method(globalThis, 'setInterval')
  try {
    const clock = createClock(1000)
    let notified = 0
    const stops = Array.from({ length: 17 }, () => clock.subscribe(() => { notified += 1 }))
    assert.equal(intervalSpy.mock.callCount(), 1, 'Before: 카드마다 1개 = 17개')
    mock.timers.tick(1000)
    assert.equal(notified, 17, '같은 순간에 17장 모두')
    assert.equal(clock.getSnapshot(), Date.now())
    stops.forEach(stop => stop())
    assert.equal(clock.size(), 0)
    mock.timers.tick(5000)
    assert.equal(notified, 17, '구독자가 없으면 타이머가 멈춘다')
  } finally {
    intervalSpy.mock.restore()
    mock.timers.reset()
  }
})

test('공유 감시자: 색 토큰을 쓰는 컴포넌트 14개가 구독해도 감시자는 1개만 만든다 (FQA-13)', () => {
  let started = 0
  let stopped = 0
  const source = createSharedSource(() => { started += 1; return () => { stopped += 1 } })
  const stops = Array.from({ length: 14 }, () => source.subscribe(() => undefined))
  assert.equal(started, 1, 'Before: 컴포넌트마다 1개 = 14개')
  stops.forEach(stop => stop())
  assert.equal(stopped, 1)
})

test('마지막 수신 시각 알림: tick 60건(10초, 초당 6건)이어도 1초에 1번 이하, 마지막 값은 늦게라도 알린다 (FQA-01)', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    let notified = 0
    const notify = createThrottledNotifier(() => { notified += 1 }, 1000)
    for (let index = 0; index < 60; index += 1) {
      notify()
      mock.timers.tick(1000 / 6)
    }
    mock.timers.tick(1000)
    assert.ok(notified <= 11, `알림 ${notified}회 (Before: tick마다 60회)`)
    assert.ok(notified >= 10, `알림 ${notified}회: 초마다 한 번은 알림`)
  } finally {
    mock.timers.reset()
  }
})
