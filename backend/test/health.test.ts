import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth, registerHealthCheck, registerHeartbeat, trackConsumer, trackProducer } from '../src/infrastructure/health.js';

// 상태 점검 (T-152, B-75). 점검 표는 프로세스 전체에서 하나라 테스트마다 다른 이름을 쓰고 그 이름의 결과만 본다

type Listener = () => void;
const fakeEmitter = (events: Record<string, string>) => {
  const listeners = new Map<string, Listener[]>();
  return {
    events,
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
};

test('a check that throws or does not finish in time counts as failing', async () => {
  registerHealthCheck('t_throws', () => { throw new Error('boom'); });
  registerHealthCheck('t_slow', () => new Promise<boolean>(resolve => setTimeout(() => resolve(true), 200)));
  registerHealthCheck('t_ok', () => true);
  const report = await evaluateHealth(50);
  assert.equal(report.checks.t_throws, false);
  assert.equal(report.checks.t_slow, false);
  assert.equal(report.checks.t_ok, true);
  assert.equal(report.ok, false);
});

test('heartbeat is healthy from registration until maxAge passes without a beat', async () => {
  let now = 1_000;
  const heartbeat = registerHeartbeat('t_loop', 100, () => now);
  assert.equal((await evaluateHealth()).checks.t_loop, true);
  now = 1_101;
  assert.equal((await evaluateHealth()).checks.t_loop, false);
  heartbeat.beat();
  assert.equal((await evaluateHealth()).checks.t_loop, true);
});

test('consumer is healthy only after joining and while heartbeats or fetches continue', async () => {
  let now = 0;
  const consumer = fakeEmitter({ GROUP_JOIN: 'join', HEARTBEAT: 'hb', FETCH_START: 'fetch', CRASH: 'crash', STOP: 'stop', DISCONNECT: 'disc' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trackConsumer('t_consumer', consumer as any, 60_000, () => now);
  assert.equal((await evaluateHealth()).checks.t_consumer, false, 'not joined yet');
  consumer.emit('join');
  assert.equal((await evaluateHealth()).checks.t_consumer, true);
  now = 61_000;
  assert.equal((await evaluateHealth()).checks.t_consumer, false, 'silent for longer than the limit');
  consumer.emit('fetch');
  assert.equal((await evaluateHealth()).checks.t_consumer, true);
  consumer.emit('crash');
  assert.equal((await evaluateHealth()).checks.t_consumer, false, 'crashed');
  consumer.emit('join');
  assert.equal((await evaluateHealth()).checks.t_consumer, true, 'rejoined after kafkajs restart');
});

test('producer fails after a failed send and recovers on the next successful send or probe', async () => {
  let fail = false;
  let probeOk = false;
  let probes = 0;
  const producer = {
    ...fakeEmitter({ CONNECT: 'connect', DISCONNECT: 'disconnect' }),
    send: async () => { if (fail) throw new Error('broker down'); return []; },
    sendBatch: async () => [],
  };
  const probe = async () => { probes += 1; if (!probeOk) throw new Error('still down'); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trackProducer('t_producer', producer as any, probe);
  assert.equal((await evaluateHealth()).checks.t_producer, false, 'not connected yet');
  producer.emit('connect');
  assert.equal((await evaluateHealth()).checks.t_producer, true);

  fail = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await assert.rejects(() => (producer.send as any)({ topic: 't', messages: [] }));
  assert.equal((await evaluateHealth()).checks.t_producer, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(probes, 1, 'probes only while failing');

  fail = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (producer.send as any)({ topic: 't', messages: [] });
  assert.equal((await evaluateHealth()).checks.t_producer, true, 'next send succeeded');

  fail = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await assert.rejects(() => (producer.send as any)({ topic: 't', messages: [] }));
  probeOk = true;
  assert.equal((await evaluateHealth()).checks.t_producer, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await evaluateHealth()).checks.t_producer, true, 'idle producer recovers when the broker answers again');

  producer.emit('disconnect');
  assert.equal((await evaluateHealth()).checks.t_producer, false);
});
