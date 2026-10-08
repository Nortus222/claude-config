export interface Diagnostic {
  readonly requestId: string;
  readonly route: string;
  readonly status: number;
  readonly duration: number;
  readonly accountHash?: string;
}
export type DiagnosticSink = (entry: Diagnostic) => void;

// Only constant route templates enter diagnostics, including malformed requests.
export function routeTemplate(method: string, path: string): string {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return 'unknown';
  const pathname = path.split('?')[0];
  if (['/v1/health', '/v1/auth/device/start', '/v1/auth/device/poll', '/v1/auth/sign-out', '/v1/machines', '/v1/sync', '/v1/decisions', '/v1/setups', '/v1/machines/self/status', '/v1/account', '/v1/account/export'].includes(pathname)) return `${method} ${pathname}`;
  if (/^\/v1\/machines\/[A-Za-z0-9-]{1,100}$/.test(pathname)) return `${method} /v1/machines/:id`;
  if (/^\/v1\/setups\/[A-Za-z0-9-]{1,100}\/revisions$/.test(pathname)) return `${method} /v1/setups/:id/revisions`;
  return 'unknown';
}
