// 프론트 데이터 요청 공통 계층 테스트 (docs/Task_ORDER.md T-165, BENCHMARK B-68)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, buildUrl, DEFAULT_API_BASE, getJson, requestStatus, resolveApiBase } from '../src/lib/api.ts'

test('resolveApiBase: 예전 형식(…/market/history)과 기본 주소를 같은 기본 주소로 바꾼다 (B-68 기준 6)', () => {
  assert.equal(resolveApiBase(undefined), DEFAULT_API_BASE)
  assert.equal(resolveApiBase(''), DEFAULT_API_BASE)
  assert.equal(resolveApiBase('http://localhost:3001/api/v1/market/history'), 'http://localhost:3001/api/v1')
  assert.equal(resolveApiBase('https://example.test/api/v1/'), 'https://example.test/api/v1')
  assert.equal(resolveApiBase('https://example.test/api/v1'), 'https://example.test/api/v1')
})

test('buildUrl: 값은 인코딩하고 없는 값은 빼며, 예전 훅들이 만들던 주소와 같다', () => {
  const base = resolveApiBase('http://localhost:3001/api/v1/market/history')
  assert.equal(buildUrl(base, 'market/history', { ticker: 'USD/KRW', timeframe: '1주' }),
    'http://localhost:3001/api/v1/market/history?ticker=USD%2FKRW&timeframe=1%EC%A3%BC')
  assert.equal(buildUrl(base, '/market/rankings', { market: 'KOSPI', type: 'cap', date: null }), 'http://localhost:3001/api/v1/market/rankings?market=KOSPI&type=cap')
  assert.equal(buildUrl(base, 'flows/market'), 'http://localhost:3001/api/v1/flows/market')
})

const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 })
const parseObject = (body: unknown) => (body && typeof body === 'object' ? (body as Record<string, unknown>) : null)

test('getJson: 정상 응답은 검증 함수를 거쳐 돌려준다', async () => {
  assert.deepEqual(await getJson('u', parseObject, { fetchImpl: ok({ a: 1 }) }), { a: 1 })
})

test('getJson: HTTP 오류·검증 실패·네트워크 오류는 종류만 담은 ApiError', async () => {
  const kindOf = async (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? `${error.kind}${error.status ?? ''}` : 'other'))
  assert.equal(await kindOf(getJson('u', parseObject, { fetchImpl: async () => new Response('{}', { status: 503 }) })), 'http503')
  assert.equal(await kindOf(getJson('u', () => null, { fetchImpl: ok({}) })), 'invalid')
  assert.equal(await kindOf(getJson('u', parseObject, { fetchImpl: async () => new Response('not-json', { status: 200 }) })), 'invalid')
  assert.equal(await kindOf(getJson('u', parseObject, { fetchImpl: async () => { throw new TypeError('fetch failed') } })), 'network')
})

// 응답하지 않는 서버: 신호가 오면 그때 실패한다
const hanging = (_input: string, init: { signal: AbortSignal }) =>
  new Promise<Response>((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))

test('getJson: 시간 제한을 넘기면 요청을 끊고 timeout으로 실패한다', async () => {
  await assert.rejects(getJson('u', parseObject, { fetchImpl: hanging, timeoutMs: 20 }), (error: unknown) => error instanceof ApiError && error.kind === 'timeout')
})

test('getJson: 화면을 벗어나 취소되면 요청을 끊고 aborted로 실패한다', async () => {
  const controller = new AbortController()
  const pending = getJson('u', parseObject, { fetchImpl: hanging, timeoutMs: 5_000, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.kind === 'aborted')
})

test('requestStatus: 오류 > 불러오는 중 > 준비 중 > 받음 순서로 판단한다', () => {
  assert.equal(requestStatus({ isPending: true, isError: false }), 'loading')
  assert.equal(requestStatus({ isPending: false, isError: true }), 'error')
  assert.equal(requestStatus({ isPending: false, isError: false }, true), 'not_ready')
  assert.equal(requestStatus({ isPending: false, isError: false }), 'loaded')
})
