// Kafka 토픽 정의 한 곳 시험 (plan.md QA-40 / P5-2 축소, docs/Task_ORDER.md T-225, BENCHMARK B-99)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dlqTopicFor, TOPIC_PAIRS, TOPICS, topicDefinitions } from '../src/infrastructure/topics.js';

const HOUR_MS = 3_600_000;
const retentionOf = (definition: { configEntries: { name: string; value: string }[] }) =>
  Number(definition.configEntries.find(entry => entry.name === 'retention.ms')?.value);

test('모든 토픽 이름이 정의 표에 정확히 한 번(원본 또는 DLQ로) 들어 있다 — 새 토픽을 표에 빠뜨리면 실패', () => {
  const inPairs = TOPIC_PAIRS.flatMap(pair => [pair.topic, pair.dlq]);
  assert.equal(new Set(inPairs).size, inPairs.length, '표 안에 중복 없음');
  assert.deepEqual([...inPairs].sort(), Object.values(TOPICS).sort());
  assert.equal(inPairs.length, 18);
});

test('원본은 자기 DLQ로 간다(이름 규칙 <원본>.dlq), 표에 없는 토픽은 시세 DLQ', () => {
  for (const pair of TOPIC_PAIRS) {
    assert.equal(dlqTopicFor(pair.topic), pair.dlq);
    assert.equal(pair.dlq, `${pair.topic}.dlq`);
  }
  assert.equal(dlqTopicFor(TOPICS.indexDaily), 'index-daily.dlq');
  assert.equal(dlqTopicFor(TOPICS.ingestionRuns), 'ingestion-runs.dlq');
  assert.equal(dlqTopicFor('unknown-topic'), TOPICS.dlq);
});

test('만들 토픽 목록: 18개, 시세 24시간·파티션 설정 적용, 나머지 원본과 DLQ는 7일·파티션 1 (예전 목록과 같음)', () => {
  const definitions = topicDefinitions(3);
  assert.equal(definitions.length, 18);
  assert.deepEqual(definitions.map(definition => definition.topic).sort(), Object.values(TOPICS).sort());
  for (const definition of definitions) {
    assert.equal(definition.replicationFactor, 1);
    if (definition.topic === TOPICS.ticks) {
      assert.equal(definition.numPartitions, 3);
      assert.equal(retentionOf(definition), 24 * HOUR_MS);
    } else {
      assert.equal(definition.numPartitions, 1, definition.topic);
      assert.equal(retentionOf(definition), 7 * 24 * HOUR_MS, definition.topic);
    }
  }
});
