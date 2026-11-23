// backend HTTP 서버 보안 설정 시험 (plan.md 5장 S-1 · S-2, docs/Task_ORDER.md T-38 · T-229, BENCHMARK B-102 · B-103)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import Fastify, { type FastifyHttpOptions } from 'fastify';
import type { Server } from 'node:http';
import { DEFAULT_HTTP_REQUEST_TIMEOUT_MS, fastifyServerOptions } from '../src/infrastructure/http-server-options.js';

function logCollector() {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
  return { lines, stream };
}

async function requestLogs(logger: object) {
  const { lines, stream } = logCollector();
  const app = Fastify({ logger: { ...logger, stream } });
  app.get('/api/v1/market/history', async () => ({ ok: true }));
  await app.inject({ method: 'GET', url: '/api/v1/market/history?ticker=KOSPI&timeframe=1주', remoteAddress: '203.0.113.7' });
  await app.close();
  return lines.join('');
}

test('S-1 대조: Fastify 기본 로거는 요청 로그에 접속자 IP·포트를 남긴다', async () => {
  const logs = await requestLogs({});
  assert.ok(logs.includes('remoteAddress') && logs.includes('203.0.113.7'));
});

test('S-1: 새 설정은 IP·포트·호스트를 남기지 않고, 요청(방법·경로)과 응답(상태) 줄은 남긴다', async () => {
  const logs = await requestLogs(fastifyServerOptions({}).logger);
  // 로그 기본 필드의 hostname은 컨테이너 이름(로그 라이브러리 기본값)이라 접속자 정보가 아니다
  assert.ok(!logs.includes('remoteAddress') && !logs.includes('remotePort') && !logs.includes('203.0.113.7'), '접속자 정보 없음');
  assert.ok(logs.includes('"method":"GET"') && logs.includes('/api/v1/market/history?ticker=KOSPI'), '요청 줄');
  assert.ok(logs.includes('"statusCode":200'), '응답 줄');
});

test('S-2: 요청 수신 시간 제한 기본 30초, 설정값으로 바꿀 수 있고 잘못된 값은 기본값', () => {
  assert.equal(DEFAULT_HTTP_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(fastifyServerOptions({}).requestTimeout, 30_000);
  assert.equal(fastifyServerOptions({ HTTP_REQUEST_TIMEOUT_MS: '10000' }).requestTimeout, 10_000);
  assert.equal(fastifyServerOptions({ HTTP_REQUEST_TIMEOUT_MS: '0' }).requestTimeout, 30_000, '0(끄기)은 받지 않음');
});

test('S-2: Fastify가 설정을 실제 HTTP 서버에 적용한다(대조: 기본은 0 = 제한 없음)', async () => {
  const configured = Fastify(fastifyServerOptions({}));
  const plain = Fastify();
  await Promise.all([configured.ready(), plain.ready()]);
  assert.equal(configured.server.requestTimeout, 30_000);
  assert.equal(plain.server.requestTimeout, 0);
  await Promise.all([configured.close(), plain.close()]);
});

// 헤더를 끝까지 보내지 않는 연결이 끊기는지와 받은 응답 첫 줄.
// Node는 시간 제한을 일정 간격(기본 30초)으로 확인하므로 시험에서는 그 간격만 50ms로 줄인다(운영과 같은 옵션·처리 함수를 씀)
async function slowClient(options: FastifyHttpOptions<Server>, waitMs: number): Promise<{ closed: boolean; status: string }> {
  const app = Fastify({
    ...options,
    logger: false,
    serverFactory: handler => createServer({ requestTimeout: options.requestTimeout ?? 0, connectionsCheckingInterval: 50 }, handler),
  });
  app.get('/', async () => ({ ok: true }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const result = await new Promise<{ closed: boolean; status: string }>(resolve => {
    let status = '';
    const socket = connect(port, '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n'));
    const timer = setTimeout(() => { socket.destroy(); resolve({ closed: false, status }); }, waitMs);
    socket.on('data', chunk => { status ||= String(chunk).split('\r\n')[0] ?? ''; });
    socket.on('close', () => { clearTimeout(timer); resolve({ closed: true, status }); });
    socket.on('error', () => undefined);
  });
  await app.close();
  return result;
}

// 운영과 같은 확인 간격(Node 기본 30초)으로 보는 시험은 35초가 걸려 test-integration/http-timeout.it.test.ts에 있다
test('S-2: 헤더를 다 보내지 않는 연결은 시간 제한 뒤 408로 끊기고, 제한 시간 전에는 유지된다(대조)', async () => {
  const options = fastifyServerOptions({ HTTP_REQUEST_TIMEOUT_MS: '300' });
  assert.deepEqual(await slowClient(options, 3_000), { closed: true, status: 'HTTP/1.1 408 Request Timeout' }, '새 설정: 300ms 뒤 408·끊김');
  assert.equal((await slowClient(fastifyServerOptions({ HTTP_REQUEST_TIMEOUT_MS: '600000' }), 1_000)).closed, false, '대조: 제한 시간 전에는 유지');
});
