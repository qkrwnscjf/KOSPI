// backend HTTP 서버(Fastify) 보안 설정 한 곳 (plan.md 5장 S-1 · S-2, docs/security.md SEC-008, QA-03 나머지)
// - S-1 (T-38, BENCHMARK B-102): Fastify 기본 로거는 요청마다 접속자 IP·포트(remoteAddress·remotePort)와 호스트를 남긴다.
//   개인정보라 요청 로그에는 방법과 경로만 남긴다(응답 줄의 상태 코드·시간은 그대로).
// - S-2 (T-229, BENCHMARK B-103): 요청 수신 시간 제한. 기본값(0)이면 헤더를 끝까지 보내지 않는 연결도 계속 유지된다.
//   Node의 요청 수신 제한이라 응답을 만드는 시간(DB 조회 등)과 연결된 웹소켓에는 적용되지 않는다.
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyHttpOptions } from 'fastify';
import { readIntSetting } from './int-setting.js';

type Source = Readonly<Record<string, string | undefined>>;

export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30_000;

// 요청 로그에 남기는 것: 방법·경로(조회 조건 포함, 개인정보 없음)
export const requestLogSerializer = (request: { method: string; url: string }) => ({ method: request.method, url: request.url });

// 잘못된 연결 처리 (S-2): 2026-11-23 시험에서 Fastify 기본 처리는 요청 수신 시간이 지나도 연결을 닫지 않았다
// (Node만 쓰면 408 뒤 닫힘, Fastify 기본은 35초 동안 유지 — BENCHMARK B-103). 그래서 직접 짧은 응답을 쓰고 연결을 닫는다.
// 응답에는 오류 내용을 넣지 않는다
export function closeBadConnection(error: { code?: string }, socket: Socket) {
  if (error.code !== 'ECONNRESET' && !socket.destroyed && socket.writable) {
    const status = error.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout' : '400 Bad Request';
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.destroy();
}

// 반환 형식을 HTTP/1 서버 옵션으로 정해 둔다(그렇지 않으면 Fastify가 HTTP/2 쪽 형식으로 추론함)
export function fastifyServerOptions(source: Source = process.env): FastifyHttpOptions<Server> {
  return {
    logger: { serializers: { req: requestLogSerializer } },
    requestTimeout: readIntSetting('HTTP_REQUEST_TIMEOUT_MS', DEFAULT_HTTP_REQUEST_TIMEOUT_MS, {}, source),
    clientErrorHandler: closeBadConnection,
  };
}
