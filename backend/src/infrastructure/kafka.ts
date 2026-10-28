import { Kafka } from 'kafkajs';
import type { KafkaMessage, Producer } from 'kafkajs';
import 'dotenv/config';

export const kafka = new Kafka({
  clientId: 'kospi-dashboard',
  brokers: process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092']
});

export const producer = kafka.producer();
export const consumer = kafka.consumer({ groupId: 'market-group' });

// 토픽 구성 (docs/Task_ORDER.md T-11, D-17)
export const TOPICS = {
  ticks: 'market-ticks',
  dlq: 'market-ticks.dlq',
  // 증시 자금 흐름 (docs/Task_ORDER.md 11단계, D-44)
  flows: 'investor-flows',
  flowsDlq: 'investor-flows.dlq',
  // KRX 일별 지수 (T-67): 하루 1개 값이라 원본 tick(market-ticks, 3시간 보관)과 섞지 않는다
  indexDaily: 'index-daily',
  indexDailyDlq: 'index-daily.dlq',
  // DART 공시 (12단계)
  disclosures: 'disclosures',
  disclosuresDlq: 'disclosures.dlq',
  // 시장 폭·거래대금 (T-106): 시장별 하루 1건
  breadth: 'market-breadth',
  breadthDlq: 'market-breadth.dlq',
  // 종목 순위 (T-113): 시장·날짜마다 1건(4가지 순위의 상위 100개)
  rankings: 'stock-rankings',
  rankingsDlq: 'stock-rankings.dlq',
  // 증시 자금 흐름 일별 통계 (11단계 B′ T-97, D-44): 데이터셋·날짜마다 1건
  marketFlows: 'market-flows',
  marketFlowsDlq: 'market-flows.dlq',
} as const;

const TICKS_PARTITIONS = Number.parseInt(process.env.KAFKA_TOPIC_PARTITIONS ?? '', 10) || 1;
const TICKS_RETENTION_MS = 24 * 60 * 60 * 1000; // 24시간: DB Sink가 하루 멈춰도 다시 채울 수 있는 재처리 버퍼
const DLQ_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7일: 잘못된 메시지 원인 분석용
const FLOWS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7일: 하루 수천 건 이하라 길게 둬도 작음. DB Sink가 며칠 멈춰도 다시 채울 수 있음

// 토픽이 없으면 만든다. worker, Gateway, DB Sink가 시작할 때 각자 호출하므로 어느 쪽이 먼저 떠도 같은 설정으로 만들어진다.
// 이미 있으면 그대로 두고, 파티션 수가 설정과 다르면 경고만 남긴다 (파티션은 줄일 수 없어서 자동으로 바꾸지 않는다).
export async function ensureTopics() {
  const admin = kafka.admin();
  await admin.connect();
  try {
    try {
      await admin.createTopics({
        waitForLeaders: true,
        topics: [
          {
            topic: TOPICS.ticks,
            numPartitions: TICKS_PARTITIONS,
            replicationFactor: 1,
            configEntries: [{ name: 'retention.ms', value: String(TICKS_RETENTION_MS) }],
          },
          {
            topic: TOPICS.dlq,
            numPartitions: 1,
            replicationFactor: 1,
            configEntries: [{ name: 'retention.ms', value: String(DLQ_RETENTION_MS) }],
          },
          {
            topic: TOPICS.flows,
            numPartitions: 1,
            replicationFactor: 1,
            configEntries: [{ name: 'retention.ms', value: String(FLOWS_RETENTION_MS) }],
          },
          {
            topic: TOPICS.flowsDlq,
            numPartitions: 1,
            replicationFactor: 1,
            configEntries: [{ name: 'retention.ms', value: String(DLQ_RETENTION_MS) }],
          },
          // KRX 일별 지수·DART 공시도 하루 수백 건 이하라 7일 보관 (DB Sink가 며칠 멈춰도 다시 채울 수 있음)
          ...[TOPICS.indexDaily, TOPICS.disclosures, TOPICS.breadth, TOPICS.rankings, TOPICS.marketFlows].map(topic => ({
            topic,
            numPartitions: 1,
            replicationFactor: 1,
            configEntries: [{ name: 'retention.ms', value: String(FLOWS_RETENTION_MS) }],
          })),
          ...[TOPICS.indexDailyDlq, TOPICS.disclosuresDlq, TOPICS.breadthDlq, TOPICS.rankingsDlq, TOPICS.marketFlowsDlq].map(topic => ({
            topic,
            numPartitions: 1,
            replicationFactor: 1,
            configEntries: [{ name: 'retention.ms', value: String(DLQ_RETENTION_MS) }],
          })),
        ],
      });
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

// 잘못된 메시지를 원본 그대로 DLQ에 보낸다 (docs/Task_ORDER.md T-13, D-19).
// 실패해도 예외를 던지지 않는다. 컨슈머가 같은 메시지에서 멈추지 않게 하기 위함.
// 원래 토픽에 맞는 DLQ로 보낸다 (market-ticks → market-ticks.dlq, investor-flows → investor-flows.dlq 등)
const DLQ_FOR: Record<string, string> = {
  [TOPICS.flows]: TOPICS.flowsDlq,
  [TOPICS.indexDaily]: TOPICS.indexDailyDlq,
  [TOPICS.disclosures]: TOPICS.disclosuresDlq,
  [TOPICS.breadth]: TOPICS.breadthDlq,
  [TOPICS.rankings]: TOPICS.rankingsDlq,
  [TOPICS.marketFlows]: TOPICS.marketFlowsDlq,
};
const dlqTopicFor = (topic: string) => DLQ_FOR[topic] ?? TOPICS.dlq;

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
    console.error(`Failed to send message to DLQ: ${error instanceof Error ? error.message : String(error)}`);
  }
}
