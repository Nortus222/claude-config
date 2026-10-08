import { createServer, type Server } from 'node:http';
import { Effect } from 'effect';
import { ERROR_STATUS, MAX_REQUEST_BODY_BYTES } from '@nortuscc/hosted-protocol';
import { ServiceFailure } from './errors.ts';
import type { ServiceHandler, ServiceResponse } from './service.ts';

export function failureResponse(failure: ServiceFailure): ServiceResponse {
  return { status: ERROR_STATUS[failure.code], body: { error: failure.code, message: 'Request failed.' },
    ...(failure.retryAfter ? { headers: { 'retry-after': String(failure.retryAfter) } } : {}) };
}
export interface RequestOwner {
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly complete: () => void;
}
export interface HttpOptions { readonly beginRequest?: () => RequestOwner }
// Drain oversized requests without destroying their socket before writing the 413 response.
export function createServiceServer(handler: ServiceHandler, options: HttpOptions = {}): Server {
  return createServer((request, response) => {
    const controller = new AbortController();
    const owner = options.beginRequest?.() ?? { signal: controller.signal, abort: () => controller.abort(), complete: () => {} };
    let running = false;
    let handlerDone = false;
    let responseDone = false;
    let complete = false;
    const finish = () => { if (!complete) { complete = true; owner.complete(); } };
    request.once('aborted', () => { owner.abort(); if (!running) finish(); });
    response.once('close', () => { responseDone = true; if (!response.writableFinished) owner.abort(); if (!running || handlerDone) finish(); });
    response.once('finish', () => { responseDone = true; if (!running || handlerDone) finish(); });
    let bytes = 0; let oversized = false; const chunks: Buffer[] = [];
    const send = (result: ServiceResponse) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(result.status, { ...(result.body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }), ...result.headers });
      response.end(result.body === undefined ? undefined : JSON.stringify(result.body));
    };
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BODY_BYTES) { oversized = true; chunks.length = 0; send(failureResponse(new ServiceFailure({ code: 'payload_too_large' }))); }
      else if (!oversized) chunks.push(chunk);
    });
    request.on('error', () => send(failureResponse(new ServiceFailure({ code: 'invalid' }))));
    request.on('end', () => {
      if (oversized || owner.signal.aborted) { finish(); return; }
      let body: unknown;
      try { if (bytes > 0) body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { send(failureResponse(new ServiceFailure({ code: 'invalid' }))); return; }
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) headers[key] = Array.isArray(value) ? value.join(',') : value;
      if (request.rawHeaders.filter((_, index) => index % 2 === 0).filter((key) => key.toLowerCase() === 'authorization').length > 1) headers.authorization = undefined;
      running = true;
      Effect.runPromise(handler({ method: request.method ?? '', path: request.url ?? '', headers, ...(bytes > 0 ? { body } : {}), ip: request.socket.remoteAddress ?? '' }).pipe(
        Effect.catch((error) => Effect.succeed(failureResponse(error))),
      ), { signal: owner.signal }).then(send, () => send(failureResponse(new ServiceFailure({ code: 'unavailable' })))).finally(() => { handlerDone = true; if (responseDone) finish(); });
    });
  });
}
