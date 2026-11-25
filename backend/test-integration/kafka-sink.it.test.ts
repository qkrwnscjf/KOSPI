// Kafka → db-sink 시세 저장 통합 시험 (plan.md P6-1 B안 축소 · QA-41, docs/Task_ORDER.md T-230, BENCHMARK B-106)
// 운영 db-sink와 같은 함수(ticks-batch.ts createTicksBatchHandler + batch-isolation.ts runIsolated)를 진짜 Kafka와 시험 DB에 붙인다.
// 시험 전용 토픽·컨슈머 그룹(이름이 it-로 시작)을 만들고 끝나면 지운다. 실제 토픽·그룹(market-ticks, db-sink)은 건드리지 않는다.
// 확인하는 것: 저장이 끝난 뒤에만 오프셋 확정(at-least-once), 다시 받은 묶음은 유니크 키로 건너뜀(중복 0), 형식 오류는 넘겨받은 처리(DLQ) 쪽으로
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Kafka, logLevel, type Admin, type Consumer, type Producer } from 'kafkajs';
import { createTicksBatchHandler } from '../src/infrastructure/sink/ticks-batch.js';
import { runIsolated } from '../src/infrastructure/sink/batch-isolation.js';
import { createTestDb, dropTestDb, type TestDb } from './it-db.js';

const RUN_ID = Date.now();
const TOPIC = `it-market-ticks-${RUN_ID}`;
const GROUP = `it-db-sink-${RUN_ID}`;
const kafka = new Kafka({ clientId: 'kospi-it', brokers: (process.env.KAFKA_BROKERS ?? 'kafka:29092').split(','), logLevel: logLevel.NOTHING });

let db: TestDb;
let admin: Admin;
let producer: Producer;

// 시세 메시지(worker가 보내는 형식). 시각은 실제 범위 안(지금 기준)
const BASE = Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000;
const tick = (symbol: string, minute: number, price: number) => ({
  key: symbol,
  value: JSON.stringify({ symbol, category: 'domestic', price, changeRate: 0.1, changePrice: 1, timestamp: BASE + minute * 60_000, collectedAt: Date.now(), producedAt: Date.now() }),
});

// 실패를 한 번 흉내 내는 DB 호출: before = 저장 전에 연결 오류, after = 저장(커밋)은 됐는데 오프셋을 확정하기 전에 실패
type Fault = 'none' | 'before' | 'after';
let fault: Fault = 'none';
let insertAttempts = 0;
const invalidReasons: string[] = [];

async function countRows() {
  const { rows } = await db.dbPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM market_ticks WHERE symbol LIKE 'IT%'`);
  return rows[0]?.n ?? 0;
}

async function committedOffset() {
  const [entry] = await admin.fetchOffsets({ groupId: GROUP, topics: [TOPIC] });
  return Number(entry?.partitions[0]?.offset ?? -1);
}

// 운영과 같은 처리 함수로 컨슈머를 돌리고, 조건을 만족하면(또는 시간 초과) 그룹에서 나온다
async function consumeUntil(done: () => Promise<boolean>, timeoutMs = 30_000) {
  const handler = createTicksBatchHandler({
    query: async (text, values) => {
      insertAttempts += 1;
      if (fault === 'before') {
        fault = 'none';
        throw new Error('simulated connection drop'); // 코드 없는 오류 = 일시적 오류 → kafkajs가 같은 묶음을 다시 줌
      }
      const result = await db.dbPool.query<{ ms: number }>(text, values);
      if (fault === 'after') {
        fault = 'none';
        throw new Error('simulated crash after commit'); // 저장은 됐지만 오프셋은 확정되지 않음
      }
      return result;
    },
    onInvalid: async (_message, reason) => { invalidReasons.push(reason); },
    onStored: () => undefined,
    onInsertError: () => undefined,
  });
  const consumer: Consumer = kafka.consumer({ groupId: GROUP, retry: { initialRetryTime: 100, retries: 20 } });
  await consumer.connect();
  await consumer.subscribe({ topics: [TOPIC], fromBeginning: true });
  await consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: payload => runIsolated(payload, handler, async () => undefined),
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !(await done())) await new Promise(resolve => setTimeout(resolve, 200));
  await consumer.disconnect(); // 나가면서 확정된 오프셋을 커밋한다
}

before(async () => {
  db = await createTestDb();
  admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ waitForLeaders: true, topics: [{ topic: TOPIC, numPartitions: 1, replicationFactor: 1 }] });
  producer = kafka.producer();
  await producer.connect();
});

after(async () => {
  await producer?.disconnect().catch(() => undefined);
  if (admin) {
    await admin.deleteGroups([GROUP]).catch(() => undefined);
    await admin.deleteTopics({ topics: [TOPIC] }).catch(() => undefined);
    const left = (await admin.listTopics()).filter(name => name.startsWith('it-'));
    await admin.disconnect();
    assert.deepEqual(left, [], '시험 토픽이 남지 않음');
  }
  await dropTestDb(db);
});

test('① 일시적 연결 오류: 같은 묶음을 다시 받아 저장, 중복 키는 1행, 형식 오류는 DLQ 쪽으로, 오프셋은 저장 뒤 5', async () => {
  await producer.send({
    topic: TOPIC,
    messages: [tick('IT_A', 0, 100), tick('IT_B', 0, 200), tick('IT_C', 0, 300), tick('IT_A', 0, 100), { key: 'IT_BAD', value: '{not json' }],
  });
  fault = 'before';
  insertAttempts = 0;
  await consumeUntil(async () => (await countRows()) >= 3);
  assert.equal(await countRows(), 3, '정상 3행(같은 키 중복은 1행)');
  assert.ok(insertAttempts >= 2, `실패 뒤 같은 묶음을 다시 저장 시도 (${insertAttempts}번)`);
  assert.ok(invalidReasons.includes('invalid_json'), '형식 오류는 DLQ 처리로 넘어감');
  assert.equal(await committedOffset(), 5, '커밋된 오프셋 = 메시지 5개 끝');
});

test('② 저장 뒤·오프셋 확정 전 실패: 다시 받은 묶음은 유니크 키로 건너뛰어 중복 0, 오프셋 7', async () => {
  await producer.send({ topic: TOPIC, messages: [tick('IT_D', 1, 400), tick('IT_B', 0, 200)] });
  fault = 'after';
  insertAttempts = 0;
  // 저장된 묶음을 다시 받아 처리할 때까지 돈다. 그룹에서 나갈 때 kafkajs가 처리 중인 묶음을 마치고 확정된 오프셋을 커밋한다
  await consumeUntil(async () => insertAttempts >= 2 && (await countRows()) === 4);
  assert.equal(await countRows(), 4, '4행(IT_D만 새로, 다시 받은 묶음도 중복 없음)');
  assert.ok(insertAttempts >= 2, `저장된 묶음을 다시 받음 (${insertAttempts}번)`);
  assert.equal(await committedOffset(), 7);
});

