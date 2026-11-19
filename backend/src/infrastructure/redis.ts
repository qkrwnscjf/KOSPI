import Redis from 'ioredis';
import 'dotenv/config';
import { createCache } from './cache.js';

export const redis = new (Redis as any)(process.env.REDIS_URL || 'redis://localhost:6379');

// 연결 오류 (plan.md QA-04 / P1-3, T-176): 'error' 리스너가 없으면 ioredis가 재연결할 때마다
// "Unhandled error event"와 스택을 남겨 Redis 장애 중 로그가 1분에 수십 줄씩 쌓였다(B-76 Before).
// 재연결은 ioredis가 계속하므로 오류 코드만 1분에 한 줄 남긴다. 주소·접속 정보는 남기지 않는다.
const REDIS_ERROR_LOG_INTERVAL_MS = 60_000;
let lastRedisErrorLogAt = 0;
let suppressedRedisErrors = 0;
redis.on('error', (error: unknown) => {
  const now = Date.now();
  if (now - lastRedisErrorLogAt < REDIS_ERROR_LOG_INTERVAL_MS) {
    suppressedRedisErrors += 1;
    return;
  }
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown';
  console.warn(`[redis] connection error (${code})${suppressedRedisErrors > 0 ? `, ${suppressedRedisErrors} more since last log` : ''}; ioredis keeps reconnecting`);
  lastRedisErrorLogAt = now;
  suppressedRedisErrors = 0;
});

// REST 조회 캐시. 장애가 응답을 막지 않는다 (T-149)
export const cache = createCache(redis);
