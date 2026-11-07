import type { KafkaMessage, Producer } from 'kafkajs';
import { kafka, TOPICS } from '../kafka.js';
import { parseTick } from '../../shared/tick-validation.js';
import { parseDisclosure } from '../../shared/disclosures.js';
import { parseMarketBreadth } from '../../shared/breadth.js';
import { parseStockRankings } from '../../shared/rankings.js';
import { parseMarketFlow } from '../../shared/market-flows.js';
import { parseYahooDaily } from '../../shared/yahoo-daily.js';
import { parseYahooBar } from '../../shared/yahoo-bars.js';
import { parseIngestionRun } from '../../shared/ingestion-runs.js';
import { isKrxDailySymbol, isKrxHistorySymbol } from '../../shared/krx-indices.js';

// DLQ 다시 처리 (docs/Task_ORDER.md T-129, D-74) — 검증용 스위치 DLQ_REPLAY=true일 때 db-sink 시작 시 한 번만 실행(기본 끔)
// 잘못된 메시지는 DLQ에 7일 보관된다(D-19). 원인(검증 규칙·필드 매핑 등)을 고친 뒤 이 도구로 원래 토픽에 다시 넣는다.
// - 지금의 검증 규칙을 통과하는 메시지만 되돌리고, 여전히 잘못된 메시지는 그대로 둔다(잘못된 데이터를 다시 퍼뜨리지 않음).
// - 원본(원래 토픽·파티션·오프셋)마다 한 번만 되돌린다. T-153 이전에는 Gateway와 db-sink가 각각 DLQ에 넣었고, 그 메시지가 보관 기간(7일) 동안 남아 있을 수 있다.
// - 별도 컨슈머 그룹(dlq-replay)이 읽은 위치를 기록하므로, 다시 실행해도 이미 본 메시지는 되돌리지 않는다.
// - 되돌린 메시지에는 replayed-from 헤더를 붙인다. Gateway는 이 헤더가 있으면 건너뛴다(지난 값으로 화면·최신값 캐시를 되돌리지 않음).
// - 로그에는 건수와 사유만 남긴다(메시지 내용 없음).

const GROUP_ID = 'dlq-replay';
const MAX_RUN_MS = 60_000;
const DLQ_TOPICS = Object.values(TOPICS).filter(topic => topic.endsWith('.dlq'));

export type ReplayDecision = { replay: true } | { replay: false; reason: string };

// 원래 토픽의 소비자(db-sink 기준, 가장 엄격)가 지금 받아들일 메시지인지
export function replayDecision(sourceTopic: string, value: Buffer | null): ReplayDecision {
  const fail = (reason: string): ReplayDecision => ({ replay: false, reason });
  if (sourceTopic === TOPICS.ticks) {
    const parsed = parseTick(value);
    if (!parsed.ok) return fail(parsed.reason);
    return parsed.tick.changePrice === undefined ? fail('change_price_missing') : { replay: true };
  }
  if (sourceTopic === TOPICS.indexDaily) {
    const parsed = parseTick(value);
    if (!parsed.ok) return fail(parsed.reason);
    return isKrxDailySymbol(parsed.tick.symbol) || isKrxHistorySymbol(parsed.tick.symbol) ? { replay: true } : fail('not_daily_symbol');
  }
  const parsers: Record<string, (input: Buffer | null) => { ok: boolean; reason?: string }> = {
    [TOPICS.disclosures]: parseDisclosure,
    [TOPICS.breadth]: parseMarketBreadth,
    [TOPICS.rankings]: parseStockRankings,
    [TOPICS.marketFlows]: parseMarketFlow,
    [TOPICS.yahooDaily]: parseYahooDaily,
    [TOPICS.yahooBars]: parseYahooBar,
    [TOPICS.ingestionRuns]: parseIngestionRun,
  };
  const parse = parsers[sourceTopic];
  if (!parse) return fail('unknown_source_topic');
  const parsed = parse(value);
  return parsed.ok ? { replay: true } : fail(parsed.reason ?? 'invalid');
}

const header = (message: KafkaMessage, name: string) => {
  const value = message.headers?.[name];
  const text = Buffer.isBuffer(value) ? value.toString() : typeof value === 'string' ? value : '';
  return text.slice(0, 100);
};

export async function runDlqReplay(producer: Producer) {
  const startedAt = Date.now();
  const counts = { seen: 0, replayed: 0, duplicate: 0, stillInvalid: {} as Record<string, number> };
  const admin = kafka.admin();
  await admin.connect();
  // 지금 쌓여 있는 끝(high watermark)까지만 처리한다. 이미 다 읽은 파티션은 처음부터 끝난 것으로 본다
  const pending = new Map<string, number>();
  try {
    const committed = await admin.fetchOffsets({ groupId: GROUP_ID, topics: DLQ_TOPICS });
    for (const topic of DLQ_TOPICS) {
      for (const { partition, high, low } of await admin.fetchTopicOffsets(topic)) {
        const done = committed.find(item => item.topic === topic)?.partitions.find(item => item.partition === partition)?.offset;
        const start = done !== undefined && Number(done) >= 0 ? Number(done) : Number(low);
        if (start < Number(high)) pending.set(`${topic}|${partition}`, Number(high));
      }
    }
  } finally {
    await admin.disconnect();
  }
  if (pending.size === 0) {
    console.log(`[dlq-replay] ${JSON.stringify({ ...counts, note: 'nothing to replay', ms: Date.now() - startedAt })}`);
    return;
  }

  const seenSources = new Set<string>();
  const consumer = kafka.consumer({ groupId: GROUP_ID });
  await consumer.connect();
  await consumer.subscribe({ topics: DLQ_TOPICS, fromBeginning: true });
  let finish: () => void = () => undefined;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const timer = setTimeout(() => finish(), MAX_RUN_MS);

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      counts.seen += 1;
      const sourceTopic = header(message, 'source-topic');
      const sourceKey = `${sourceTopic}|${header(message, 'source-partition')}|${header(message, 'source-offset')}`;
      if (seenSources.has(sourceKey)) {
        counts.duplicate += 1;
      } else {
        seenSources.add(sourceKey);
        const decision = replayDecision(sourceTopic, message.value);
        if (decision.replay) {
          await producer.send({ topic: sourceTopic, messages: [{ key: message.key, value: message.value, headers: { 'replayed-from': topic } }] });
          counts.replayed += 1;
        } else {
          counts.stillInvalid[decision.reason] = (counts.stillInvalid[decision.reason] ?? 0) + 1;
        }
      }
      const target = pending.get(`${topic}|${partition}`);
      if (target !== undefined && Number(message.offset) + 1 >= target) pending.delete(`${topic}|${partition}`);
      if (pending.size === 0) finish();
    },
  });

  await finished;
  clearTimeout(timer);
  await consumer.disconnect();
  console.log(`[dlq-replay] ${JSON.stringify({ ...counts, unfinishedPartitions: pending.size, ms: Date.now() - startedAt })}`);
}
