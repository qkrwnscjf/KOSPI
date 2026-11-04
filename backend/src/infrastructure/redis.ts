import Redis from 'ioredis';
import 'dotenv/config';
import { createCache } from './cache.js';

export const redis = new (Redis as any)(process.env.REDIS_URL || 'redis://localhost:6379');

// REST 조회 캐시. 장애가 응답을 막지 않는다 (T-149)
export const cache = createCache(redis);
