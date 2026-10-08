import { Effect } from 'effect';
import { decodeHosted, DeviceStartResponseSchema } from '@nortuscc/hosted-protocol';
import { ServiceFailure } from './errors.ts';
import type { GitHub, GitHubDevice, GitHubExchange, GitHubUser } from './github.ts';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_DELAY_SECONDS = 3600;
const unavailable = (retryAfter = 1) => new ServiceFailure({ code: 'unavailable', retryAfter });
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
};
const positiveSeconds = (value: unknown, max: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > max) throw unavailable();
  return value;
};
const credential = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(value)) throw unavailable();
  return value;
};
const boundedDelay = (value: number) => Math.min(MAX_DELAY_SECONDS, Math.max(1, Math.ceil(value)));
function retryDelay(headers: Headers, now: number, throttled: boolean): number {
  const retry = headers.get('retry-after');
  let delay: number | undefined;
  if (retry !== null) {
    const seconds = /^\d+$/.test(retry) ? Number(retry) : undefined;
    if (seconds !== undefined) { if (Number.isSafeInteger(seconds) && seconds >= 0) delay = boundedDelay(seconds); }
    else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry)) {
      const deadline = Date.parse(retry);
      if (Number.isFinite(deadline)) delay = boundedDelay((deadline - now) / 1000);
    }
  }
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = headers.get('x-ratelimit-reset');
    const seconds = reset !== null && /^\d+$/.test(reset) ? Number(reset) : NaN;
    if (Number.isSafeInteger(seconds) && seconds >= 0 && Number.isSafeInteger(seconds * 1000)) {
      delay = Math.max(delay ?? 1, boundedDelay((seconds * 1000 - now) / 1000));
    }
  }
  return delay ?? (throttled ? 60 : 1);
}

/** Fixed no-scope GitHub device flow; credentials live only in the current exchange. */
export function makeGitHub(options: { readonly clientId: string; readonly fetch: typeof fetch; readonly now: () => number; readonly timeoutMs?: number }): GitHub['Service'] {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!/^[A-Za-z0-9_]{1,100}$/.test(options.clientId) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000) throw unavailable();
  let cooldownUntil = 0;
  const request = <A>(url: string, init: RequestInit, project: (value: Record<string, unknown>, startedAt: number) => A): Effect.Effect<A, ServiceFailure> => Effect.tryPromise({
    try: async (signal) => {
      const startedAt = options.now();
      if (cooldownUntil > startedAt) throw unavailable(boundedDelay((cooldownUntil - startedAt) / 1000));
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let rejectAbort!: (error: ServiceFailure) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const abort = () => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        rejectAbort(unavailable());
      };
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      let failureDelay = 1;
      try {
        if (signal.aborted) throw unavailable();
        const upstream = options.fetch(url, { ...init, redirect: 'error', signal: controller.signal }).then((response) => {
          if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
          return response;
        });
        const response = await Promise.race([upstream, aborted]);
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw unavailable(); }
        const throttled = response.status === 403 || response.status === 429;
        failureDelay = retryDelay(response.headers, options.now(), throttled);
        if (response.status !== 200 || response.redirected) {
          void response.body?.cancel().catch(() => {});
          if (throttled) cooldownUntil = Math.max(cooldownUntil, options.now() + failureDelay * 1000);
          throw unavailable(failureDelay);
        }
        if (!response.body) throw unavailable();
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const chunk = await Promise.race([reader.read(), aborted]);
          if (controller.signal.aborted) throw unavailable();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_BODY_BYTES) { controller.abort(); void reader.cancel().catch(() => {}); throw unavailable(); }
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return project(object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))), startedAt);
      } catch {
        throw unavailable(failureDelay);
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        reader?.releaseLock();
      }
    },
    catch: (error) => error instanceof ServiceFailure ? error : unavailable(),
  });
  const post = <A>(url: string, fields: Record<string, string>, project: (value: Record<string, unknown>, startedAt: number) => A) => request(url, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'nortuscc-hosted-service' },
    body: new URLSearchParams({ client_id: options.clientId, ...fields }),
  }, project);
  return {
    requestDevice: () => post('https://github.com/login/device/code', {}, (body, startedAt): GitHubDevice => {
      if ('error' in body) throw unavailable();
      const deviceCode = credential(body.device_code);
      const interval = positiveSeconds(body.interval, MAX_DELAY_SECONDS);
      const expiresIn = positiveSeconds(body.expires_in, 900);
      const response = decodeHosted(DeviceStartResponseSchema, { pendingId: 'validation', userCode: body.user_code, verificationUri: body.verification_uri, interval, expiresIn });
      const expiresAt = startedAt + expiresIn * 1000;
      if (!Number.isSafeInteger(expiresAt)) throw unavailable();
      return { deviceCode, userCode: response.userCode, verificationUri: response.verificationUri, interval, expiresIn, expiresAt };
    }),
    exchange: (deviceCode) => Effect.suspend(() => {
      try { credential(deviceCode); } catch { return Effect.fail(unavailable()); }
      return post('https://github.com/login/oauth/access_token', { device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, (body): GitHubExchange => {
        if ('error' in body) {
          switch (body.error) {
            case 'authorization_pending': return { type: 'pending' };
            case 'slow_down': return { type: 'slow-down', ...('interval' in body ? { interval: positiveSeconds(body.interval, MAX_DELAY_SECONDS) } : {}) };
            case 'expired_token': case 'token_expired': return { type: 'expired' };
            case 'access_denied': return { type: 'denied' };
            default: throw unavailable();
          }
        }
        if (body.token_type !== 'bearer' || body.scope !== '') throw unavailable();
        return { type: 'success', token: credential(body.access_token) };
      });
    }),
    user: (token) => Effect.suspend(() => {
      try { credential(token); } catch { return Effect.fail(unavailable()); }
      return request('https://api.github.com/user', { method: 'GET', headers: {
        accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2026-03-10', 'user-agent': 'nortuscc-hosted-service',
      } }, (body): GitHubUser => {
        if ('error' in body || typeof body.id !== 'number' || !Number.isSafeInteger(body.id) || body.id <= 0 || typeof body.login !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(body.login)) throw unavailable();
        return { id: body.id, login: body.login };
      });
    }),
  };
}
