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

// Health check
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

    // 종료 처리 (docs/Task_ORDER.md T-28): 새 요청과 WebSocket을 먼저 닫고, Kafka 컨슈머 → Redis → DB 순서로 정리한다.
    registerShutdown('backend', [
      { name: 'http + socket.io', run: () => fastify.close() },
      { name: 'kafka', run: () => stopMarketGateway() },
      { name: 'redis', run: () => redis.quit() },
      { name: 'db pool', run: () => dbPool.end() },
    ]);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
