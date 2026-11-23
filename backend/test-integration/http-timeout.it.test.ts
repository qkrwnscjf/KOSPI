// 요청 수신 시간 제한을 운영과 같은 방식으로 확인 (plan.md 5장 S-2, docs/Task_ORDER.md T-229, BENCHMARK B-103)
// 단위 시험은 Node의 확인 간격을 50ms로 줄여서 본다. 여기서는 운영 backend와 같은 Fastify 옵션 그대로(확인 간격 Node 기본 30초) 35초 기다린다.
// DB·외부 접속 없음(127.0.0.1 임의 포트, 시험 안에서만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, type AddressInfo } from 'node:net';
import Fastify, { type FastifyHttpOptions } from 'fastify';
import type { Server } from 'node:http';
import { fastifyServerOptions } from '../src/infrastructure/http-server-options.js';

async function slowClient(options: FastifyHttpOptions<Server>, waitMs: number): Promise<{ closed: boolean; status: string; afterMs: number }> {
  const app = Fastify({ ...options, logger: false });
  app.get('/', async () => ({ ok: true }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const startedAt = Date.now();
  const result = await new Promise<{ closed: boolean; status: string; afterMs: number }>(resolve => {
    let status = '';
    const socket = connect(port, '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n'));
    const timer = setTimeout(() => { socket.destroy(); resolve({ closed: false, status, afterMs: Date.now() - startedAt }); }, waitMs);
    socket.on('data', chunk => { status ||= String(chunk).split('\r\n')[0] ?? ''; });
    socket.on('close', () => { clearTimeout(timer); resolve({ closed: true, status, afterMs: Date.now() - startedAt }); });
    socket.on('error', () => undefined);
  });
  await app.close();
  return result;
}

test('S-2 운영 방식: backend 옵션 그대로면 느린 연결이 Node 확인 간격(30초) 안에 408로 끊긴다', async () => {
  const options = fastifyServerOptions({ HTTP_REQUEST_TIMEOUT_MS: '300' });
  const { clientErrorHandler: _handler, ...withoutHandler } = options;
  // 두 서버를 함께 돌려 시간을 아낀다. Fastify 기본 처리 결과는 기록만 한다(실행마다 달라 판정에 쓰지 않음)
  const [ours, fastifyDefault] = await Promise.all([slowClient(options, 35_000), slowClient(withoutHandler, 35_000)]);
  console.log(`[it-http-timeout] ours=${JSON.stringify(ours)} fastifyDefault=${JSON.stringify(fastifyDefault)}`);
  assert.equal(ours.closed, true);
  assert.equal(ours.status, 'HTTP/1.1 408 Request Timeout');
});
