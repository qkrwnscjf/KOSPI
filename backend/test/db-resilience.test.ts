// DB 끊김 처리·정리용 마이그레이션 시험 (plan.md P1-1 · P1-7, docs/Task_ORDER.md T-209 · T-211, BENCHMARK B-82 · B-84)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import {
  applyMigrations, dbPool, dbPoolConfig, logDbConnectionError, REQUIRED_MIGRATION_VERSIONS, schemaReady, withDbClient, type Migration,
} from '../src/infrastructure/db.js';

const dbError = (code: string) => Object.assign(new Error('failed'), { code });

test('T-209: 풀에 error 리스너가 있어 쉬던 연결이 끊겨도 프로세스가 끝나지 않는다', () => {
  // 리스너가 없으면 EventEmitter가 'error'를 다시 던져 Node가 프로세스를 끝낸다(B-75 ④)
  assert.ok(dbPool.listenerCount('error') >= 1);
  assert.doesNotThrow(() => dbPool.emit('error', dbError('57P01')));
});

test('T-209: 연결 오류 로그는 1분에 1줄, 오류 코드만', () => {
  // 앞 시험이 지금 시각으로 한 줄 남겼으므로 그보다 충분히 뒤의 시각으로 잰다
  const base = Date.now() + 10 * 60_000;
  assert.equal(logDbConnectionError('idle client', dbError('57P01'), base), true);
  assert.equal(logDbConnectionError('idle client', dbError('57P01'), base + 30_000), false);
  assert.equal(logDbConnectionError('idle client', new Error('no code'), base + 61_000), true);
});

test('T-209: 연결 시간 제한 기본 10초, 문장·응답 시간 제한은 설정했을 때만', () => {
  const defaults = dbPoolConfig({});
  assert.equal(defaults.connectionTimeoutMillis, 10_000);
  assert.equal(defaults.idleTimeoutMillis, 0);
  assert.equal('statement_timeout' in defaults, false);
  assert.equal('query_timeout' in defaults, false);
  const backend = dbPoolConfig({ DB_STATEMENT_TIMEOUT_MS: '15000', DB_QUERY_TIMEOUT_MS: '20000', DB_CONNECT_TIMEOUT_MS: '5000' });
  assert.equal(backend.connectionTimeoutMillis, 5_000);
  assert.equal((backend as { statement_timeout?: number }).statement_timeout, 15_000);
  assert.equal((backend as { query_timeout?: number }).query_timeout, 20_000);
  assert.equal(dbPoolConfig({ DB_CONNECT_TIMEOUT_MS: 'abc' }).connectionTimeoutMillis, 10_000);
  assert.equal(dbPoolConfig({ DB_CONNECT_TIMEOUT_MS: '-1' }).connectionTimeoutMillis, 10_000);
});

function fakePool() {
  const client = Object.assign(new EventEmitter(), {
    released: [] as (Error | boolean | undefined)[],
    release(error?: Error | boolean) { this.released.push(error); },
  });
  return { client, pool: { connect: async () => client } as unknown as pg.Pool };
}

test('T-209: 빌린 연결이 끊기면 받아서 기록하고, 돌려줄 때 그 연결을 버린다', async () => {
  const { client, pool } = fakePool();
  const broken = dbError('57P01');
  await withDbClient(pool, async () => {
    assert.doesNotThrow(() => client.emit('error', broken));
  });
  assert.deepEqual(client.released, [broken]);
  assert.equal(client.listenerCount('error'), 0);

  const ok = fakePool();
  assert.equal(await withDbClient(ok.pool, async () => 'done'), 'done');
  assert.deepEqual(ok.client.released, [undefined]);
});

function recordingClient(failOn: Record<string, string>) {
  const queries: string[] = [];
  return {
    queries,
    client: {
      query: async (sql: string) => {
        queries.push(sql);
        const code = failOn[sql];
        if (code) throw dbError(code);
        return {};
      },
    },
  };
}

const MIGRATIONS: Migration[] = [
  { version: 1, name: 'one', statements: ['S1'] },
  { version: 2, name: 'cleanup two', statements: ['S2'], cleanup: true },
  { version: 3, name: 'three', statements: ['S3'] },
];

test('T-211: 정리용 마이그레이션이 실패해도 예외 없이 계속, 기록하지 않고 뒤 필수 마이그레이션은 적용', async () => {
  const { client, queries } = recordingClient({ S2: 'P0001' });
  const result = await applyMigrations(client, MIGRATIONS, new Set());
  assert.deepEqual(result.applied, [1, 3]);
  assert.deepEqual(result.pendingCleanup, [{ version: 2, code: 'P0001' }]);
  assert.equal(queries.filter(sql => sql.startsWith('INSERT INTO schema_migrations')).length, 2);
});

test('T-211: 필수 마이그레이션이 실패하면 지금처럼 예외(뒤 마이그레이션 실행 안 함)', async () => {
  const { client, queries } = recordingClient({ S1: '42P01' });
  await assert.rejects(applyMigrations(client, MIGRATIONS, new Set()));
  assert.deepEqual(queries, ['S1']);
});

test('T-211: 이미 적용한 번호는 건너뛰고, 다음 기동에 정리용을 다시 시도한다', async () => {
  const { client, queries } = recordingClient({});
  const result = await applyMigrations(client, MIGRATIONS, new Set([1, 3]));
  assert.deepEqual(result.applied, [2]);
  assert.deepEqual(queries[0], 'S2');
});

test('T-211: 정리용(15 · 16)이 남아 있어도 필수 번호가 다 있으면 스키마 준비', () => {
  assert.equal(REQUIRED_MIGRATION_VERSIONS.includes(15), false);
  assert.equal(REQUIRED_MIGRATION_VERSIONS.includes(16), false);
  assert.equal(REQUIRED_MIGRATION_VERSIONS.includes(14), true);
  const requiredOnly = REQUIRED_MIGRATION_VERSIONS;
  assert.equal(schemaReady(requiredOnly), true);
  assert.equal(schemaReady(requiredOnly.filter(version => version !== 14)), false);
  assert.equal(schemaReady([...requiredOnly, 15, 16]), true);
});
