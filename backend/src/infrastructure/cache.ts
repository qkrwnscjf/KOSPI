import { Counter } from './metrics.js';

// REST 조회 캐시 (docs/Task_ORDER.md T-149, BENCHMARK B-56)
// 캐시는 없어도 되는 부가 기능이라 장애가 응답을 막으면 안 된다. Redis가 끊기면 ioredis가 요청을 재시도하며 기다려서
// 응답이 수십 초 걸리고 끝내 500이 됐다(DB는 정상인데도, B-56 Before). Gateway의 T-23과 같은 원칙이다.
// - 읽기: 준비되지 않았거나, 실패하거나, 시간이 넘으면 "캐시 없음"으로 보고 DB에서 읽는다.
// - 쓰기: 기다리지 않고, 실패해도 응답에 영향을 주지 않는다.

const bypassedTotal = new Counter('kospi_cache_bypassed_total', 'REST cache reads or writes skipped by reason (not_ready / read_failed / write_failed)');

export const CACHE_READ_TIMEOUT_MS = 200;

export interface CacheClient {
  status: string;
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, mode: 'EX', seconds: number) => Promise<unknown>;
}

export function createCache(client: CacheClient, timeoutMs = CACHE_READ_TIMEOUT_MS) {
  return {
    async readJson<T = unknown>(key: string): Promise<T | null> {
      if (client.status !== 'ready') {
        bypassedTotal.inc({ reason: 'not_ready' });
        return null;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raw = await Promise.race([
          client.get(key),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('cache read timeout')), timeoutMs); }),
        ]);
        return raw ? (JSON.parse(raw) as T) : null;
      } catch {
        bypassedTotal.inc({ reason: 'read_failed' });
        return null;
      } finally {
        clearTimeout(timer);
      }
    },

    writeJson(key: string, value: unknown, ttlSeconds: number): void {
      if (client.status !== 'ready') {
        bypassedTotal.inc({ reason: 'not_ready' });
        return;
      }
      client.set(key, JSON.stringify(value), 'EX', ttlSeconds).catch(() => bypassedTotal.inc({ reason: 'write_failed' }));
    },
  };
}
