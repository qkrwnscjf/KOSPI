// 사이드바 열기/접기 상태 저장 (docs/Task_ORDER.md T-199, BENCHMARK B-79)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCollapsed, SIDEBAR_STORAGE_KEY, writeCollapsed } from '../src/lib/sidebarState.ts'

const memoryStore = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

test('접힘 상태를 저장하고 다시 읽는다 (새로고침해도 유지)', () => {
  const store = memoryStore()
  assert.equal(readCollapsed(store), false, '처음에는 펼침')
  writeCollapsed(store, true)
  assert.equal(store.getItem(SIDEBAR_STORAGE_KEY), 'true')
  assert.equal(readCollapsed(store), true)
  writeCollapsed(store, false)
  assert.equal(readCollapsed(store), false)
})

test('저장소를 쓸 수 없으면 펼친 상태로 시작하고 저장은 조용히 건너뛴다', () => {
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.equal(readCollapsed(broken), false)
  assert.doesNotThrow(() => writeCollapsed(broken, true))
  assert.equal(readCollapsed(undefined), false)
})
