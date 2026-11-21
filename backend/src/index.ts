import 'dotenv/config';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifySocketIO from 'fastify-socket.io';
import { initMarketGateway, stopMarketGateway } from './domains/market/market.gateway.js';
import { historyController, startHistorySelfCheck } from './domains/history/history.controller.js';
import { flowsController } from './domains/flows/flows.controller.js';
import { disclosuresController, startDisclosureSelfCheck } from './domains/disclosures/disclosures.controller.js';
import { pipelineController, startPipelineSelfCheck } from './domains/system/pipeline.controller.js';
import { startRestSelfCheck } from './domains/system/rest-self-check.js';
import { dbPool, initDB } from './infrastructure/db.js';
import { redis } from './infrastructure/redis.js';
import { metricsConfig, startMetricsLog, startMetricsServer } from './infrastructure/metrics.js';
import { registerShutdown } from './infrastructure/shutdown.js';
import { registerHealthCheck } from './infrastructure/health.js';

const fastify = Fastify({ logger: true });

// Register CORS
fastify.register(fastifyCors, {
  origin: '*', // Adjust for production
});

// Register Socket.io plugin
fastify.register(fastifySocketIO as any, {
  cors: {
    origin: '*',
  },
  // 브라우저가 보내는 메시지는 구독 요청(심볼 이름)뿐이라 작게 제한한다 (docs/security.md SEC-005). 기본값은 1MB.
  maxHttpBufferSize: 10_000,
});

// Register REST Controllers
fastify.register(historyController);
fastify.register(flowsController);
fastify.register(disclosuresController);
fastify.register(pipelineController);

// Health check: 프로세스가 요청에 응답하는지만 본다(공개 포트, 생존 확인용).
// 의존성(DB·Kafka 컨슈머)까지 보는 점검은 내부 전용 포트의 /health다 (T-152). Redis는 끊겨도 REST·실시간이 동작하도록 만들어 점검에 넣지 않는다(T-23, T-149)
registerHealthCheck('db', async () => {
  await dbPool.query('SELECT 1');
  return true;
});
fastify.get('/api/health', async (request, reply) => {
  return { status: 'ok', message: 'Kospi Dashboard API is running.' };
});

fastify.ready(async err => {
  if (err) throw err;

  // Initialize WebSocket gateways
  // 핸들러만 바로 등록하고, Kafka 연결은 백그라운드에서 성공할 때까지 재시도한다 (docs/Task_ORDER.md T-14).
  // 연결 성공 여부는 'Gateway Kafka consumer connected.' 로그와 kospi_gateway_kafka_connected 메트릭으로 확인한다.
  initMarketGateway((fastify as any).io);
  fastify.log.info('Market WebSocket handlers registered (Kafka consumer connects in background).');
});

const start = async () => {
  // 종료 처리는 마이그레이션·listen 전에 등록한다 (plan.md QA-07, T-228). 예전에는 listen 뒤에 등록해서 그 전에 온 종료 신호가 무시됐다.
  // 시작 전에 불려도 각 단계는 안전하다(닫을 서버·연결이 없으면 바로 끝남): HTTP 서버와 WebSocket을 먼저 닫고, Kafka 컨슈머 → Redis → DB 순서 (T-28)
  registerShutdown('backend', [
    { name: 'http + socket.io', run: () => fastify.close() },
    { name: 'kafka', run: () => stopMarketGateway() },
    { name: 'redis', run: () => redis.quit() },
    { name: 'db pool', run: () => dbPool.end() },
  ]);
  try {
    await initDB();
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`Server is now listening on http://localhost:${port}`);

    // 메트릭은 공개 API 포트가 아닌 내부 전용 포트로 노출한다 (docs/Task_ORDER.md T-01)
    startMetricsServer(metricsConfig.port);
    startMetricsLog('backend', metricsConfig.logIntervalMs);
    fastify.log.info(`Metrics server listening on :${metricsConfig.port} (internal only)`);
    startHistorySelfCheck();
    startDisclosureSelfCheck();
    startPipelineSelfCheck();
    startRestSelfCheck(fastify);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
