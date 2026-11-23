// Kafka 토픽 정의 한 곳 (plan.md QA-40 / P5-2 축소, docs/Task_ORDER.md T-225, BENCHMARK B-99)
// 예전에는 토픽 이름(TOPICS), 만들 토픽 목록(원본 줄·DLQ 줄), DLQ 대응표가 따로 있어,
// 새 토픽을 대응표에 빠뜨리면 잘못된 메시지가 엉뚱한 market-ticks.dlq로 갔다.
// 지금은 원본 ↔ DLQ ↔ 보관 기간을 TOPIC_PAIRS 한 표에 적고, 만들 목록과 DLQ 대응표는 이 표에서 만든다.
// 이 파일은 kafkajs·환경 설정을 읽지 않는 순수 모듈이다(시험: test/topics.test.ts). 연결은 kafka.ts.

// 토픽 구성 (docs/Task_ORDER.md T-11, D-17)
// 투자자별 흐름(investor-flows)은 보내는 수집기가 없어 T-164에서 지웠다(로컬 볼륨의 토픽도 2026-11-07 삭제)
export const TOPICS = {
  ticks: 'market-ticks',
  dlq: 'market-ticks.dlq',
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
  // Yahoo 일봉 (T-143): db-sink가 받아 보내고 db-sink가 저장한다. Gateway는 읽지 않는다
  yahooDaily: 'yahoo-daily',
  yahooDailyDlq: 'yahoo-daily.dlq',
  // Yahoo 장중 봉 (T-151): 꺼져 있던 구간의 1일·1주 그래프용. db-sink가 받아 보내고 db-sink가 저장한다. Gateway는 읽지 않는다
  yahooBars: 'yahoo-bars',
  yahooBarsDlq: 'yahoo-bars.dlq',
  // 적재 실행 기록 (T-118): 수집기가 보내고 db-sink가 저장한다. Gateway는 읽지 않는다
  ingestionRuns: 'ingestion-runs',
  ingestionRunsDlq: 'ingestion-runs.dlq',
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

const HOUR_MS = 60 * 60 * 1000;
export const TOPIC_RETENTION_MS = {
  ticks: 24 * HOUR_MS, // 24시간: DB Sink가 하루 멈춰도 다시 채울 수 있는 재처리 버퍼
  daily: 7 * 24 * HOUR_MS, // 7일: 하루 수천 건 이하라 길게 둬도 작음. DB Sink가 며칠 멈춰도 다시 채울 수 있음
  dlq: 7 * 24 * HOUR_MS, // 7일: 잘못된 메시지 원인 분석용
} as const;

// 원본 토픽과 그 DLQ, 원본 보관 기간. DLQ는 모두 7일. 시세(ticks)만 파티션 수 설정을 따른다
export const TOPIC_PAIRS: readonly { topic: TopicName; dlq: TopicName; retentionMs: number; partitioned?: true }[] = [
  { topic: TOPICS.ticks, dlq: TOPICS.dlq, retentionMs: TOPIC_RETENTION_MS.ticks, partitioned: true },
  { topic: TOPICS.indexDaily, dlq: TOPICS.indexDailyDlq, retentionMs: TOPIC_RETENTION_MS.daily },
  { topic: TOPICS.disclosures, dlq: TOPICS.disclosuresDlq, retentionMs: TOPIC_RETENTION_MS.daily },
  { topic: TOPICS.breadth, dlq: TOPICS.breadthDlq, retentionMs: TOPIC_RETENTION_MS.daily },
  { topic: TOPICS.rankings, dlq: TOPICS.rankingsDlq, retentionMs: TOPIC_RETENTION_MS.daily },
  { topic: TOPICS.marketFlows, dlq: TOPICS.marketFlowsDlq, retentionMs: TOPIC_RETENTION_MS.daily },
  { topic: TOPICS.yahooDaily, dlq: TOPICS.yahooDailyDlq, retentionMs: TOPIC_RETENTION_MS.daily },
  { topic: TOPICS.yahooBars, dlq: TOPICS.yahooBarsDlq, retentionMs: TOPIC_RETENTION_MS.daily },
  { topic: TOPICS.ingestionRuns, dlq: TOPICS.ingestionRunsDlq, retentionMs: TOPIC_RETENTION_MS.daily },
];

export interface TopicDefinition {
  topic: string;
  numPartitions: number;
  replicationFactor: number;
  configEntries: { name: string; value: string }[];
}

const topicDefinition = (topic: string, retentionMs: number, numPartitions = 1): TopicDefinition => ({
  topic,
  numPartitions,
  replicationFactor: 1,
  configEntries: [{ name: 'retention.ms', value: String(retentionMs) }],
});

// 만들 토픽 목록: 표의 원본(보관 기간 그대로, 시세만 파티션 수 적용)과 DLQ(7일)
export function topicDefinitions(ticksPartitions: number): TopicDefinition[] {
  return TOPIC_PAIRS.flatMap(pair => [
    topicDefinition(pair.topic, pair.retentionMs, pair.partitioned ? ticksPartitions : 1),
    topicDefinition(pair.dlq, TOPIC_RETENTION_MS.dlq),
  ]);
}

// 원래 토픽에 맞는 DLQ (market-ticks → market-ticks.dlq, index-daily → index-daily.dlq 등). 표에 없는 토픽은 시세 DLQ
const DLQ_FOR = new Map<string, string>(TOPIC_PAIRS.map(pair => [pair.topic, pair.dlq]));
export const dlqTopicFor = (topic: string): string => DLQ_FOR.get(topic) ?? TOPICS.dlq;
