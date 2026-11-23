import { Kafka } from 'kafkajs';
import type { KafkaMessage, Producer } from 'kafkajs';
import 'dotenv/config';
import { Counter } from './metrics.js';
import { readIntSetting } from './int-setting.js';
import { dlqTopicFor, TOPICS, topicDefinitions } from './topics.js';

export const kafka = new Kafka({
  clientId: 'kospi-dashboard',
  brokers: process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092']
});

export const producer = kafka.producer();

// 토픽 이름·DLQ·보관 기간은 topics.ts 한 곳에 있다 (plan.md QA-40 / P5-2 축소, T-225). 가져다 쓰는 쪽은 그대로 kafka.js에서 TOPICS를 읽는다
export { TOPICS } from './topics.js';

// 정수 설정은 한 함수로 읽는다(QA-39 / T-225)
const TICKS_PARTITIONS = readIntSetting('KAFKA_TOPIC_PARTITIONS', 1);
const TOPIC_DEFINITIONS = topicDefinitions(TICKS_PARTITIONS);

// 토픽이 없으면 만든다. worker, Gateway, DB Sink가 시작할 때 각자 호출하므로 어느 쪽이 먼저 떠도 같은 설정으로 만들어진다.
// 이미 있으면 그대로 두고, 파티션 수가 설정과 다르면 경고만 남긴다 (파티션은 줄일 수 없어서 자동으로 바꾸지 않는다).
export async function ensureTopics() {
  const admin = kafka.admin();
  await admin.connect();
  try {
    try {
      // 없는 토픽만 만든다 (T-146). 이미 있는 토픽까지 요청하면 브로커 오류 응답이 ERROR 로그로 남아 진짜 오류가 묻힌다
      const existing = new Set(await admin.listTopics());
      const topics = TOPIC_DEFINITIONS.filter(definition => !existing.has(definition.topic));
      if (topics.length > 0) await admin.createTopics({ waitForLeaders: true, topics });
    } catch (error) {
      // 여러 서비스가 동시에 만들려고 하면 "이미 있음" 에러가 날 수 있다. 아래 메타데이터 확인으로 판단한다.
      console.warn(`createTopics: ${error instanceof Error ? error.message : String(error)}`);
    }

    const required = Object.values(TOPICS);
    const metadata = await admin.fetchTopicMetadata({ topics: required });
    const ticks = metadata.topics.find(topic => topic.name === TOPICS.ticks);
    if (!ticks || !required.every(name => metadata.topics.some(topic => topic.name === name))) {
      throw new Error('Kafka topics are missing after ensureTopics');
    }
    if (ticks.partitions.length !== TICKS_PARTITIONS) {
      console.warn(`Topic ${TOPICS.ticks} has ${ticks.partitions.length} partitions, configured ${TICKS_PARTITIONS}.`);
    }
    return ticks.partitions.length;
  } finally {
    await admin.disconnect();
  }
}

// 브로커가 응답하는지 확인한다 (T-152). 프로듀서 전송이 실패한 상태에서만 health check가 부른다(평소에는 요청 없음)
export async function probeBroker() {
  const admin = kafka.admin({ retry: { retries: 0 } });
  await admin.connect();
  try {
    await admin.describeCluster();
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

// 잘못된 메시지를 원본 그대로 DLQ에 보낸다 (docs/Task_ORDER.md T-13, D-19).
// 실패해도 예외를 던지지 않는다. 컨슈머가 같은 메시지에서 멈추지 않게 하기 위함.
// 원래 토픽에 맞는 DLQ로 보낸다. 대응표는 topics.ts의 TOPIC_PAIRS에서 만든다 (T-225)
// DLQ 전송 실패 (T-157): 메시지는 원래 토픽의 보관 기간 동안만 남으므로 알아챌 수 있어야 한다
const dlqSendFailedTotal = new Counter('kospi_dlq_send_failed_total', 'Messages that could not be sent to a DLQ, by source topic');

export async function sendToDlq(
  dlqProducer: Producer,
  source: { consumer: string; topic: string; partition: number; message: KafkaMessage; reason: string }
) {
  try {
    await dlqProducer.send({
      topic: dlqTopicFor(source.topic),
      messages: [{
        key: source.message.key,
        value: source.message.value,
        headers: {
          reason: source.reason,
          consumer: source.consumer,
          'source-topic': source.topic,
          'source-partition': String(source.partition),
          'source-offset': source.message.offset,
        },
      }],
    });
  } catch (error) {
    dlqSendFailedTotal.inc({ topic: source.topic });
    console.error(`Failed to send message to DLQ: ${error instanceof Error ? error.message : String(error)}`);
  }
}
