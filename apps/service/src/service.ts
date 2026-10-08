import { Effect } from 'effect';
import { createHash } from 'node:crypto';
import { ERROR_STATUS } from '@nortuscc/hosted-protocol';
import { Store } from './store.ts';
import { GitHub } from './github.ts';
import { ServiceFailure } from './errors.ts';
import { authenticate, devicePoll, deviceStart, touchMachine, type AuthenticatedPrincipal } from './auth.ts';
import { machineRoute } from './machines.ts';
import { tokenBucket } from './limits.ts';
import { routeTemplate, type DiagnosticSink } from './diagnostics.ts';
import { newId } from './ids.ts';
import { metadataHandler } from './metadata.ts';

export interface ServiceRequest { readonly method: string; readonly path: string; readonly headers: Readonly<Record<string, string | undefined>>; readonly body?: unknown; readonly ip: string }
export interface ServiceResponse { readonly status: number; readonly body?: unknown; readonly headers?: Readonly<Record<string, string>> }
export type ServiceHandler = (request: ServiceRequest) => Effect.Effect<ServiceResponse, ServiceFailure>;
export interface ServiceConfig { readonly allowlistedLogins: readonly string[]; readonly openSignup: boolean; readonly pollAfter: number }
export interface ServiceOptions {
  readonly now: () => number;
  readonly config: ServiceConfig;
  readonly diagnostic: DiagnosticSink;
  readonly metadata?: (request: ServiceRequest, principal: AuthenticatedPrincipal, store: Store['Service']) => Effect.Effect<ServiceResponse, ServiceFailure>;
}
export function makeService(options: ServiceOptions): Effect.Effect<ServiceHandler, never, Store | GitHub> {
  return Effect.gen(function* () {
    const store = yield* Store; const github = yield* GitHub;
    const metadata = options.metadata ?? metadataHandler(options.now,options.config.pollAfter);
    const starts = tokenBucket(10, 3600000, options.now); const machineRequests = tokenBucket(60, 60000, options.now);
    return (request: ServiceRequest) => {
      const start = options.now(); let accountHash: string | undefined;
      const handle = Effect.gen(function* () {
        const { method, path, body } = request;
        if (!path.startsWith('/') || path.includes('#') || /[\x00-\x20\\]/.test(path) || path.split('?')[0].includes('%')) return yield* Effect.fail(new ServiceFailure({ code: 'invalid' }));
        const pathname = path.split('?')[0];
        const bodyless = method === 'GET' || method === 'DELETE' || pathname === '/v1/auth/sign-out';
        if (bodyless && body !== undefined) return yield* Effect.fail(new ServiceFailure({ code: 'invalid' }));
        if (path.includes('?') && !((method === 'GET' && pathname === '/v1/sync') || (method === 'GET' && /^\/v1\/setups\/[A-Za-z0-9-]+\/revisions$/.test(pathname)))) return yield* Effect.fail(new ServiceFailure({ code: 'invalid' }));
        if (method === 'GET' && path === '/v1/health') return { status: 200, body: { status: 'ok' } };
        if (method === 'POST' && path === '/v1/auth/device/start') {
          yield* Effect.try({ try: () => starts(request.ip), catch: (e) => e as ServiceFailure });
          return yield* deviceStart(store, github, body, options.now);
        }
        if (method === 'POST' && path === '/v1/auth/device/poll') return yield* devicePoll(store, github, body, options.config, options.now);
        const principal = yield* authenticate(store, request.headers.authorization);
        accountHash = createHash('sha256').update(principal.accountId).digest('hex');
        yield* Effect.try({ try: () => machineRequests(`${principal.accountId}:${principal.machineId}`), catch: (e) => e as ServiceFailure });
        yield* touchMachine(store, principal, options.now());
        const response = yield* machineRoute(request, principal, store);
        if (response) return response;
        return yield* metadata(request,principal,store);
      });
      const log = (status: number) => { try { options.diagnostic({ requestId: newId(options.now()), route: routeTemplate(request.method, request.path), status, duration: Math.max(0, options.now() - start), ...(accountHash ? { accountHash } : {}) }); } catch { /* Diagnostics cannot change a response. */ } };
      return handle.pipe(Effect.tap((response) => Effect.sync(() => log(response.status))), Effect.tapError((error) => Effect.sync(() => log(ERROR_STATUS[error.code]))));
    };
  });
}
