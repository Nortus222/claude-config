import { Context, Data, Effect, Layer } from 'effect';
import { decodeHosted, ErrorResponseSchema, ERROR_CODES, ERROR_STATUS, MAX_REQUEST_BODY_BYTES } from '@nortuscc/hosted-protocol';

export const HOSTED_FAILURE_CODES = [...ERROR_CODES, 'invalid_url', 'invalid_request', 'invalid_response',
  'redirect', 'network', 'timeout', 'credential_storage', 'keychain_unavailable', 'storage'] as const;
export type HostedFailureCode = typeof HOSTED_FAILURE_CODES[number];

// Safe to project into status or IPC. Never attach a rejected value, message or underlying cause.
export class HostedFailure extends Data.TaggedError('HostedFailure')<{
  readonly code: HostedFailureCode;
  readonly status?: number;
  readonly retryAfter?: number;
}> {
  override get message() { return `Hosted operation failed (${this.code})`; }
}

export type HostedRequest = {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly token?: string;
  readonly body?: unknown;
  readonly etag?: string;
};
export type HostedResponse = { readonly status: number; readonly body?: unknown; readonly etag?: string; readonly retryAfter?: number };

export class HostedTransport extends Context.Service<HostedTransport, {
  readonly request: (request: HostedRequest) => Effect.Effect<HostedResponse, HostedFailure>;
}>()('hosted-client/HostedTransport') {}

const fail = (code: HostedFailureCode, status?: number, retryAfter?: number): never => {
  throw new HostedFailure({ code, ...(status === undefined ? {} : { status }), ...(retryAfter === undefined ? {} : { retryAfter }) });
};

// The root includes the API prefix, for example https://service.example/v1. Paths append beneath it.
export const httpTransport = (baseUrl: string, options: { readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number } = {}) =>
  Layer.succeed(HostedTransport, {
    request: (request) => Effect.tryPromise({
      try: async (signal) => {
        let base: URL;
        try { base = new URL(baseUrl); } catch { return fail('invalid_url'); }
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return fail('invalid_url');
        let path: string;
        try { path = decodeURIComponent(request.path.split('?')[0]!); } catch { return fail('invalid_request'); }
        if (!request.path.startsWith('/') || request.path.startsWith('//') || request.path.includes('#')
          || path.includes('\\') || path.includes('//') || path.split('/').some((part) => part === '.' || part === '..')
          || /[\r\n]/.test(request.path)) return fail('invalid_request');
        const root = base.href.replace(/\/$/, '') + '/';
        const url = new URL(request.path.slice(1), root);
        const keys = [...url.searchParams.keys()];
        if (new Set(keys).size !== keys.length) return fail('invalid_request');
        if (url.origin !== base.origin || !url.href.startsWith(root)) return fail('invalid_request');
        if (request.token !== undefined && /[\r\n]/.test(request.token)) return fail('invalid_request');
        const timeoutMs = options.timeoutMs ?? 30_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return fail('invalid_request');
        let body: string | undefined;
        try {
          if (request.body !== undefined) {
            body = JSON.stringify(request.body);
            if (body === undefined) return fail('invalid_request');
            if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) return fail('payload_too_large');
          }
        } catch (error) { if (error instanceof HostedFailure) throw error; return fail('invalid_request'); }
        const controller = new AbortController();
        let rejectCancelled!: (error: HostedFailure) => void;
        const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
        const abort = () => { controller.abort(); rejectCancelled(new HostedFailure({ code: 'network' })); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new HostedFailure({ code: 'timeout' })); }, timeoutMs);
        });
        try {
          return await Promise.race([timeout, cancelled, (async () => {
            const headers = new Headers({ Accept: 'application/json' });
            if (body !== undefined) headers.set('Content-Type', 'application/json');
            if (request.token !== undefined) headers.set('Authorization', `Bearer ${request.token}`);
            if (request.etag !== undefined) headers.set('If-None-Match', request.etag);
            const response = await (options.fetch ?? globalThis.fetch)(url, {
              method: request.method, headers, ...(body === undefined ? {} : { body }),
              signal: controller.signal, redirect: 'manual', credentials: 'omit',
            });
            const status = response.status;
            const rawRetry = response.headers.get('Retry-After');
            const retry = rawRetry === null ? undefined : /^\d+$/.test(rawRetry) ? Number(rawRetry)
              : /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(rawRetry)
                ? Math.max(0, Math.ceil((Date.parse(rawRetry) - Date.now()) / 1000)) : undefined;
            const retryAfter = retry !== undefined && Number.isSafeInteger(retry) && retry >= 0 ? retry : undefined;
            const etag = response.headers.get('ETag') ?? undefined;
            const metadata = { status, ...(etag === undefined ? {} : { etag }), ...(retryAfter === undefined ? {} : { retryAfter }) };
            if (response.redirected) return fail('redirect', status);
            if (status === 304 || status === 204) return metadata;
            if (status >= 300 && status < 400) return fail('redirect', status);
            let decoded: unknown;
            try { decoded = await response.json(); } catch { return fail('invalid_response', status, retryAfter); }
            if (status >= 200 && status < 300) return { ...metadata, body: decoded };
            let error: ReturnType<typeof decodeHosted<typeof ErrorResponseSchema>>;
            try { error = decodeHosted(ErrorResponseSchema, decoded); } catch { return fail('invalid_response', status, retryAfter); }
            if (ERROR_STATUS[error.error] !== status) return fail('invalid_response', status, retryAfter);
            return fail(error.error, status, retryAfter);
          })()]);
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        }
      },
      catch: (error) => error instanceof HostedFailure ? error : new HostedFailure({ code: 'network' }),
    }),
  });
