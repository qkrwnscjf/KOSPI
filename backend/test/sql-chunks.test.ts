// 여러 행 INSERT의 매개변수 한도 (plan.md QA-05 / P1-6, T-185)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkForParams, MAX_QUERY_PARAMS } from '../src/infrastructure/sink/sql-chunks.js';

const POSTGRES_PARAM_LIMIT = 65_535;

test('밀린 시세 5만 행(행당 7개)을 나눠도 한 문장의 매개변수가 한도를 넘지 않고, 행이 빠지거나 겹치지 않는다', () => {
  const rows = Array.from({ length: 50_000 }, (_, index) => index);
  const chunks = chunkForParams(rows, 7);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length * 7 <= MAX_QUERY_PARAMS && MAX_QUERY_PARAMS < POSTGRES_PARAM_LIMIT);
  assert.deepEqual(chunks.flat(), rows);
});

test('평소 크기의 묶음은 나누지 않는다 (문장 수 그대로)', () => {
  assert.equal(chunkForParams(Array.from({ length: 30 }, (_, index) => index), 7).length, 1);
  assert.deepEqual(chunkForParams([], 5), []);
});
