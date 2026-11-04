import { Server, Socket } from 'socket.io';
import type { Consumer, EachMessagePayload } from 'kafkajs';
import { flowRoom, isFlowMarket, parseInvestorFlow } from '../../shared/flows.js';
import { DISCLOSURE_ROOM, isTargetStock, parseDisclosure } from '../../shared/disclosures.js';
import { isKrxDailySymbol, isKrxHistorySymbol } from '../../shared/krx-indices.js';
import { kafka, TOPICS, ensureTopics } from '../../infrastructure/kafka.js';
import { Counter, Gauge, Latency } from '../../infrastructure/metrics.js';
import { marketService } from './market.service.js';
import { parseTick } from '../../shared/tick-validation.js';
import { isSubscribableSymbol } from '../../shared/symbols.js';
import type { TickData } from '../../shared/types.js';

// 측정 지표 (docs/Task_ORDER.md T-01)
const messagesTotal = new Counter('kospi_gateway_messages_total', 'Kafka messages processed by the gateway');
const kafkaLatency = new Latency('kospi_gateway_kafka_latency_seconds', 'Worker produce to gateway consume');
const redisSetDuration = new Latency('kospi_gateway_redis_set_duration_seconds', 'Redis latest tick SET duration');
const pipelineLatency = new Latency('kospi_gateway_pipeline_latency_seconds', 'Worker collection to WebSocket emit by category');
const e2eLatency = new Latency('kospi_gateway_e2e_latency_seconds', 'Source timestamp to WebSocket emit by category');
const wsConnections = new Gauge('kospi_ws_connections', 'Current WebSocket connections');
wsConnections.set({}, 0);

// Kafka 연결 상태 (docs/Task_ORDER.md T-14)
const kafkaConnected = new Gauge('kospi_gateway_kafka_connected', 'Whether the gateway Kafka consumer is connected (1) or not (0)');
const kafkaConnectAttempts = new Counter('kospi_gateway_kafka_connect_attempts_total', 'Gateway Kafka connect attempts by result (success / failure)');
kafkaConnected.set({}, 0);

// 잘못된 메시지 방어 (docs/Task_ORDER.md T-13, SEC-002)
// Gateway는 세고 건너뛰기만 한다. Gateway가 읽는 토픽은 db-sink도 같은 검증으로 읽고, DLQ에는 db-sink가 넣는다(T-153, B-59: 같은 메시지가 두 번 들어가던 문제)
const invalidTotal = new Counter('kospi_gateway_invalid_messages_total', 'Invalid messages skipped by the gateway, by reason (db-sink sends them to the DLQ)');
const redisErrorsTotal = new Counter('kospi_gateway_redis_errors_total', 'Redis errors while caching the latest tick');

// emit 순서 (docs/Task_ORDER.md T-23, BENCHMARK B-05)
const emitDelay = new Latency('kospi_gateway_emit_delay_seconds', 'Kafka consume to WebSocket emit inside the gateway');
const redisSkippedTotal = new Counter('kospi_gateway_redis_skipped_total', 'Latest tick not cached because Redis was not connected');

// 구독 요청 검증 (docs/security.md SEC-005)
const subscribeRejectedTotal = new Counter('kospi_gateway_subscribe_rejected_total', 'Rejected subscribe / unsubscribe requests by reason');

// 증시 자금 흐름 (11단계)
const flowMessagesTotal = new Counter('kospi_gateway_flow_messages_total', 'Investor flow messages emitted by the gateway');
const flowPipelineLatency = new Latency('kospi_gateway_flow_pipeline_latency_seconds', 'Flows collector collection to WebSocket emit');

// KRX 일별 지수·DART 공시 (T-67, 12단계)
const dailyMessagesTotal = new Counter('kospi_gateway_daily_index_messages_total', 'KRX daily index messages emitted by the gateway');
const disclosureMessagesTotal = new Counter('kospi_gateway_disclosure_messages_total', 'Live DART disclosures emitted by the gateway');

// DLQ 다시 처리 (T-129)
const replayedSkippedTotal = new Counter('kospi_gateway_replayed_skipped_total', 'Messages replayed from a DLQ, skipped by the gateway (storage only)');

const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

// 이 핸들러는 예외를 던지지 않는다. 던지면 kafkajs가 같은 메시지를 계속 다시 시도해서 실시간 경로 전체가 멈춘다 (SEC-002).
const handleMessage = (io: Server) => async ({ topic, partition, message }: EachMessagePayload) => {
  const consumedAt = Date.now();
  // DLQ에서 되돌린 메시지(T-129)는 저장용이다. 지난 값이라 화면에 보내거나 최신값 캐시를 덮어쓰지 않는다
  if (message.headers?.['replayed-from'] !== undefined) {
    replayedSkippedTotal.inc();
    return;
  }
  if (topic === TOPICS.flows) {
    handleFlowMessage(io, topic, partition, message.value, message.offset, consumedAt);
    return;
  }
  if (topic === TOPICS.indexDaily) {
    handleIndexDailyMessage(io, topic, partition, message.value, message.offset);
    return;
  }
  if (topic === TOPICS.disclosures) {
    handleDisclosureMessage(io, topic, partition, message.value, message.offset);
    return;
  }
  const parsed = parseTick(message.value);
  if (!parsed.ok) {
    invalidTotal.inc({ reason: parsed.reason });
    console.warn(`Gateway skipped invalid message at ${topic}[${partition}]@${message.offset}: ${parsed.reason}`);
    return;
  }

  const tick = parsed.tick;
  if (tick.producedAt !== undefined) {
    kafkaLatency.observe({}, consumedAt - tick.producedAt);
  }

  // Broadcast to specific symbol room. 실시간 전송을 먼저 하고 Redis 저장은 기다리지 않는다 (T-23, BENCHMARK B-05).
  // 이전에는 Redis 저장을 기다린 뒤 emit해서, Redis가 끊기면 메시지마다 재시도를 기다리느라 실시간 경로 전체가 멈췄다.
  const emittedAt = Date.now();
  io.to(tick.symbol).emit('tick', tick);
  emitDelay.observe({}, emittedAt - consumedAt);

  if (tick.collectedAt !== undefined) {
    pipelineLatency.observe({ category: tick.category }, emittedAt - tick.collectedAt);
  }
  e2eLatency.observe({ category: tick.category }, emittedAt - tick.timestamp);
  messagesTotal.inc();

  void cacheLatestTick(tick);
};

// 증시 자금 흐름 (docs/Task_ORDER.md 11단계 A). 시세와 같은 규칙: 검증 → 먼저 전송 → 캐시는 기다리지 않음. 예외를 던지지 않는다.
function handleFlowMessage(io: Server, topic: string, partition: number, value: Buffer | null, offset: string, consumedAt: number) {
  const parsed = parseInvestorFlow(value);
  if (!parsed.ok) {
    invalidTotal.inc({ reason: `flow_${parsed.reason}` });
    console.warn(`Gateway skipped invalid flow message at ${topic}[${partition}]@${offset}: ${parsed.reason}`);
    return;
  }
  const flow = parsed.flow;
  io.to(flowRoom(flow.market)).emit('flow', flow);
  flowMessagesTotal.inc();
  if (flow.collectedAt !== undefined) flowPipelineLatency.observe({}, Date.now() - flow.collectedAt);
  emitDelay.observe({}, Date.now() - consumedAt);

  void marketService.saveLatestFlow(flow).catch(error => {
    redisErrorsTotal.inc();
    console.error(`Gateway failed to cache latest flow for ${flow.market}: ${errorMessage(error)}`);
  });
}

// KRX 일별 지수 (docs/Task_ORDER.md T-67). 시세와 같은 'tick' 이벤트로 보내서 화면 카드가 그대로 받는다.
// 소스 시각이 하루 전이라 지연 지표(e2e·pipeline)에는 넣지 않는다. 최신값 캐시는 더 새로운 날짜일 때만 바꾼다.
function handleIndexDailyMessage(io: Server, topic: string, partition: number, value: Buffer | null, offset: string) {
  const parsed = parseTick(value);
  // Yahoo 지표의 과거 일봉(T-104 보완, 코스피 200 등)은 DB에만 저장한다. 실시간 값은 Yahoo tick이 주므로 화면에 보내지 않는다
  if (parsed.ok && isKrxHistorySymbol(parsed.tick.symbol)) return;
  const reason = !parsed.ok ? parsed.reason : !isKrxDailySymbol(parsed.tick.symbol) ? 'not_daily_symbol' : undefined;
  if (reason || !parsed.ok) {
    invalidTotal.inc({ reason: `index_${reason ?? 'unknown'}` });
    console.warn(`Gateway skipped invalid daily index message at ${topic}[${partition}]@${offset}: ${reason}`);
    return;
  }
  const tick = parsed.tick;
  io.to(tick.symbol).emit('tick', tick);
  dailyMessagesTotal.inc();
  void marketService.saveLatestTickIfNewer(tick).catch(error => {
    redisErrorsTotal.inc();
    console.error(`Gateway failed to cache latest daily index for ${tick.symbol}: ${errorMessage(error)}`);
  });
}

// DART 공시 (12단계). 수집 주기에 새로 발견한 공시(live)만 화면에 바로 보낸다. 과거 채우기분은 REST로만 보인다.
function handleDisclosureMessage(io: Server, topic: string, partition: number, value: Buffer | null, offset: string) {
  const parsed = parseDisclosure(value);
  if (!parsed.ok) {
    invalidTotal.inc({ reason: `disclosure_${parsed.reason}` });
    console.warn(`Gateway skipped invalid disclosure message at ${topic}[${partition}]@${offset}: ${parsed.reason}`);
    return;
  }
  const { disclosure } = parsed;
  if (!disclosure.live || !isTargetStock(disclosure.stockCode)) return;
  // 브라우저에는 화면에 필요한 필드만 보낸다 (수집 시각 등 내부 값 제외)
  io.to(DISCLOSURE_ROOM).emit('disclosure', {
    rceptNo: disclosure.rceptNo,
    rceptDate: disclosure.rceptDate,
    stockCode: disclosure.stockCode,
    corpName: disclosure.corpName,
    reportName: disclosure.reportName,
    group: disclosure.group,
    kind: disclosure.kind,
    isCorrection: disclosure.isCorrection,
    amount: disclosure.amount,
  });
  disclosureMessagesTotal.inc();
}

// 최신 tick을 Redis에 저장한다. 예외를 던지지 않는다 (실패해도 실시간 전송에는 영향 없음).
async function cacheLatestTick(tick: TickData) {
  const startedAt = Date.now();
  try {
    const saved = await marketService.saveLatestTick(tick);
    if (saved) {
      redisSetDuration.observe({}, Date.now() - startedAt);
    } else {
      redisSkippedTotal.inc();
    }
  } catch (error) {
    redisErrorsTotal.inc();
    console.error(`Gateway failed to cache latest tick for ${tick.symbol}: ${errorMessage(error)}`);
  }
}

// 컨슈머 1개를 만들어 연결·구독·실행한다. 실패하면 인스턴스를 정리하고 에러를 던진다.
// 실패한 인스턴스를 재사용하지 않고 시도마다 새로 만든다 (상태가 꼬이는 것을 피하기 위함).
// 종료 처리(T-28)에서 끊을 수 있도록 현재 컨슈머를 기억한다.
let activeConsumer: Consumer | undefined;
let shuttingDown = false;

async function startConsumer(io: Server) {
  const consumer = kafka.consumer({ groupId: 'market-group' });
  activeConsumer = consumer;
  try {
    await ensureTopics();
    await consumer.connect();
    await consumer.subscribe({ topics: [TOPICS.ticks, TOPICS.flows, TOPICS.indexDaily, TOPICS.disclosures], fromBeginning: false });

    consumer.on(consumer.events.GROUP_JOIN, () => kafkaConnected.set({}, 1));
    consumer.on(consumer.events.CRASH, event => {
      kafkaConnected.set({}, 0);
      console.error(`Gateway Kafka consumer crashed: ${errorMessage(event.payload.error)} (restart: ${event.payload.restart})`);
      // kafkajs가 스스로 재시작하지 않는 중단이면 재연결 루프로 다시 연결한다.
      if (!event.payload.restart && !shuttingDown) {
        consumer.disconnect().catch(() => undefined);
        void connectWithRetry(io);
      }
    });

    await consumer.run({ eachMessage: handleMessage(io) });
    kafkaConnectAttempts.inc({ result: 'success' });
    kafkaConnected.set({}, 1);
    console.log('Gateway Kafka consumer connected.');
  } catch (error) {
    kafkaConnectAttempts.inc({ result: 'failure' });
    await consumer.disconnect().catch(() => undefined);
    throw error;
  }
}

// 연결에 성공할 때까지 백그라운드에서 재시도한다 (1초부터 2배씩, 최대 30초).
// 이전에는 한 번 실패하면 다시 시도하지 않아서, backend를 재시작해야 실시간 경로가 복구되었다 (P-04).
let connecting = false;
async function connectWithRetry(io: Server) {
  if (connecting) return;
  connecting = true;

  let delay = RECONNECT_INITIAL_DELAY_MS;
  while (!shuttingDown) {
    try {
      await startConsumer(io);
      connecting = false;
      return;
    } catch (error) {
      console.error(`Gateway Kafka connect failed: ${errorMessage(error)}. Retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS);
    }
  }
  connecting = false;
}

// 종료 처리 (docs/Task_ORDER.md T-28): 재연결을 멈추고, 컨슈머가 그룹에서 정상적으로 나가게 한다.
// 정상적으로 나가면 다시 시작할 때 Kafka가 이전 멤버의 세션 만료를 기다리지 않는다.
export async function stopMarketGateway() {
  shuttingDown = true;
  await activeConsumer?.disconnect().catch(error => console.error(`Gateway consumer disconnect failed: ${errorMessage(error)}`));
  kafkaConnected.set({}, 0);
}

// WebSocket 핸들러는 Kafka 연결과 상관없이 먼저 등록한다 (docs/Task_ORDER.md T-14).
// Kafka가 없어도 브라우저는 접속해서 Redis에 캐시된 최신값을 받을 수 있다.
export const initMarketGateway = (io: Server) => {
  io.on('connection', (socket: Socket) => {
    console.log(`Client connected to gateway: ${socket.id}`);
    wsConnections.inc();

    // 구독 요청은 허용된 심볼 문자열만 받는다 (docs/security.md SEC-005).
    // 목록에 없는 값은 방을 만들지 않고, 로그에도 받은 값을 그대로 쓰지 않는다(로그 위조 방지).
    // 이미 참여한 방이면 다시 조회하지 않으므로, 연결 하나가 만드는 방과 Redis 조회는 허용 목록 수(시세 16 + 자금 흐름 2)를 넘지 않는다.
    socket.on('subscribe_market', async (symbol: unknown) => {
      if (!isSubscribableSymbol(symbol)) {
        subscribeRejectedTotal.inc({ event: 'subscribe', reason: 'unknown_symbol' });
        return;
      }
      if (socket.rooms.has(symbol)) {
        subscribeRejectedTotal.inc({ event: 'subscribe', reason: 'already_joined' });
        return;
      }
      socket.join(symbol);
      console.log(`Client ${socket.id} subscribed to ${symbol}`);

      // Send the most recent cached value immediately upon subscription (자금 흐름 방은 최신 flow)
      try {
        const flowMarket = symbol.startsWith('flows:') ? symbol.slice('flows:'.length) : undefined;
        if (symbol === DISCLOSURE_ROOM) {
          // 공시 목록의 첫 화면은 REST로 받는다. 방에는 참여만 한다.
        } else if (flowMarket !== undefined) {
          const latestFlow = isFlowMarket(flowMarket) ? await marketService.getLatestFlow(flowMarket) : null;
          if (latestFlow) socket.emit('flow', latestFlow);
        } else {
          // KRX 일별 지수는 캐시가 비어 있으면(Gateway가 뜨기 전에 수집된 경우) DB의 마지막 값으로 채운다 (T-67)
          const latestTick = (await marketService.getLatestTick(symbol))
            ?? (isKrxDailySymbol(symbol) ? await marketService.getLatestDailyIndex(symbol) : null);
          if (latestTick) {
            socket.emit('tick', latestTick);
          }
        }
      } catch (error) {
        redisErrorsTotal.inc();
        console.error(`Gateway failed to read latest tick for ${symbol}: ${errorMessage(error)}`);
      }
    });

    // 소켓 1개를 여러 차트가 함께 쓰므로(T-24), 화면에서 사라진 심볼은 구독을 해제한다.
    socket.on('unsubscribe_market', (symbol: unknown) => {
      if (!isSubscribableSymbol(symbol)) {
        subscribeRejectedTotal.inc({ event: 'unsubscribe', reason: 'unknown_symbol' });
        return;
      }
      socket.leave(symbol);
    });

    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
      wsConnections.dec();
    });
  });

  void connectWithRetry(io);
};
