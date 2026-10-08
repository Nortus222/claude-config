import { createServer, type Server } from 'node:http';
import { Effect } from 'effect';
import { ERROR_STATUS, MAX_REQUEST_BODY_BYTES } from '@nortuscc/hosted-protocol';
import { ServiceFailure } from './errors.ts';
import type { ServiceHandler, ServiceResponse } from './service.ts';

export function failureResponse(failure: ServiceFailure): ServiceResponse {
  return { status: ERROR_STATUS[failure.code], body: { error: failure.code, message: 'Request failed.' },
    ...(failure.retryAfter ? { headers: { 'retry-after': String(failure.retryAfter) } } : {}) };
}
// Drain oversized requests without destroying their socket before writing the 413 response.
export function createServiceServer(handler: ServiceHandler): Server {
  return createServer((request, response) => {
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
      if (oversized) return;
      let body: unknown;
      try { if (bytes > 0) body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { send(failureResponse(new ServiceFailure({ code: 'invalid' }))); return; }
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) headers[key] = Array.isArray(value) ? value.join(',') : value;
      if (request.rawHeaders.filter((_, index) => index % 2 === 0).filter((key) => key.toLowerCase() === 'authorization').length > 1) headers.authorization = undefined;
      Effect.runPromise(handler({ method: request.method ?? '', path: request.url ?? '', headers, ...(bytes > 0 ? { body } : {}), ip: request.socket.remoteAddress ?? '' }).pipe(
        Effect.catch((error) => Effect.succeed(failureResponse(error))),
      )).then(send, () => send(failureResponse(new ServiceFailure({ code: 'unavailable' }))));
    });
  });
}
