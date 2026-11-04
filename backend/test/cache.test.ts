// REST 조회 캐시 테스트 (docs/Task_ORDER.md T-149): 캐시 장애가 응답을 막지 않는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache, type CacheClient } from '../src/infrastructure/cache.js';

const client = (overrides: Partial<CacheClient>): CacheClient => ({
  status: 'ready',
  get: async () => null,
  set: async () => 'OK',
  ...overrides,
});

test('readJson: 저장된 값을 돌려주고, 없으면 null', async () => {
  assert.deepEqual(await createCache(client({ get: async () => '{"a":1}' })).readJson('k'), { a: 1 });
  assert.equal(await createCache(client({})).readJson('k'), null);
});

test('readJson: 준비되지 않았으면 Redis를 호출하지 않고 바로 null', async () => {
  let called = false;
  const cache = createCache(client({ status: 'reconnecting', get: async () => { called = true; return '{}'; } }));
  assert.equal(await cache.readJson('k'), null);
  assert.equal(called, false);
});

test('readJson: 실패·깨진 값·시간 초과는 예외 없이 null', async () => {
  assert.equal(await createCache(client({ get: async () => { throw new Error('down'); } })).readJson('k'), null);
  assert.equal(await createCache(client({ get: async () => '{broken' })).readJson('k'), null);
  const startedAt = Date.now();
  assert.equal(await createCache(client({ get: () => new Promise(() => undefined) }), 20).readJson('k'), null);
  assert.ok(Date.now() - startedAt < 500);
});

test('writeJson: 준비됐을 때만 쓰고, 실패해도 예외가 밖으로 나오지 않는다', async () => {
  const writes: unknown[][] = [];
  createCache(client({ set: async (...args) => { writes.push(args); return 'OK'; } })).writeJson('k', { a: 1 }, 30);
  assert.deepEqual(writes, [['k', '{"a":1}', 'EX', 30]]);

  let called = false;
  createCache(client({ status: 'end', set: async () => { called = true; return 'OK'; } })).writeJson('k', 1, 30);
  assert.equal(called, false);

  createCache(client({ set: async () => { throw new Error('down'); } })).writeJson('k', 1, 30);
  await new Promise(resolve => setTimeout(resolve, 5)); // 처리되지 않은 거부가 있으면 테스트가 실패한다
});
