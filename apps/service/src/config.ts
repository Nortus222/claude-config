export interface RuntimeConfig {
  readonly githubClientId: string;
  readonly cosmosEndpoint: string;
  readonly cosmosDatabase: string;
  readonly managedIdentityClientId?: string;
  readonly host: '127.0.0.1' | '::1' | '0.0.0.0';
  readonly port: number;
  readonly openSignup: boolean;
  readonly allowlistedLogins: readonly string[];
  readonly pollAfter: number;
  readonly sweepIntervalSeconds: number;
  readonly sweepTimeoutSeconds: number;
  readonly shutdownGraceSeconds: number;
  readonly localEmulator: boolean;
  readonly emulatorKey?: string;
}
const prefix = 'NORTUSCC_SERVICE_';
const keys = new Set(['GITHUB_CLIENT_ID', 'COSMOS_ENDPOINT', 'COSMOS_DATABASE', 'MANAGED_IDENTITY_CLIENT_ID', 'HOST', 'PORT', 'OPEN_SIGNUP', 'ALLOWLIST', 'POLL_AFTER_SECONDS', 'SWEEP_INTERVAL_SECONDS', 'SWEEP_TIMEOUT_SECONDS', 'SHUTDOWN_GRACE_SECONDS', 'LOCAL_EMULATOR', 'EMULATOR_KEY']);
const invalid = (): never => { throw new Error('Invalid service configuration.'); };
/** Parse service settings and reject identity paths whose work the runtime cannot own. */
export function parseServiceEnvironment(env: Readonly<Record<string, string | undefined>>): RuntimeConfig {
  for (const key of Object.keys(env)) if (key.startsWith(prefix) && !keys.has(key.slice(prefix.length))) invalid();
  const get = (key: string) => env[`${prefix}${key}`];
  const required = (key: string, pattern: RegExp) => { const value = get(key); if (!value || !pattern.test(value)) return invalid(); return value; };
  const boolean = (key: string, fallback: boolean) => { const value = get(key); if (value === undefined) return fallback; if (value !== 'true' && value !== 'false') return invalid(); return value === 'true'; };
  const integer = (key: string, fallback: number, maximum: number) => { const value = get(key); if (value === undefined) return fallback; if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) return invalid(); return Number(value); };
  const localEmulator = boolean('LOCAL_EMULATOR', false);
  // Identity 4.13.3's token-exchange path discards the owned transport and cancellation.
  if (!localEmulator && env.AZURE_FEDERATED_TOKEN_FILE !== undefined) return invalid();
  const endpoint = get('COSMOS_ENDPOINT');
  if (!endpoint || /[\x00-\x20\x7f\\]/.test(endpoint)) return invalid();
  let url: URL;
  try { url = new URL(endpoint); } catch { return invalid(); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^https?:\/\/[^/?#]+\/?$/.test(endpoint)) return invalid();
  const literalLoopback = /^https?:\/\/(127\.0\.0\.1|\[::1\])(?::[1-9][0-9]*)?\/?$/.test(endpoint);
  const hostname = url.hostname.replace(/\.$/, '');
  const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]'
    || /^127\./.test(hostname) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname);
  if (localEmulator ? !literalLoopback : url.protocol !== 'https:' || loopback) return invalid();
  const emulatorKey = get('EMULATOR_KEY');
  const managedIdentityClientId = get('MANAGED_IDENTITY_CLIENT_ID');
  if (localEmulator ? !emulatorKey || emulatorKey.length > 1024 || /[\x00-\x20\x7f]/.test(emulatorKey) || managedIdentityClientId !== undefined : emulatorKey !== undefined) return invalid();
  if (managedIdentityClientId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(managedIdentityClientId)) return invalid();
  const host = get('HOST') ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1' && host !== '0.0.0.0') return invalid();
  const allowlistedLogins = get('ALLOWLIST') ? get('ALLOWLIST')!.split(',') : [];
  if (allowlistedLogins.some((login) => !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login)) || new Set(allowlistedLogins.map((login) => login.toLowerCase())).size !== allowlistedLogins.length) return invalid();
  return {
    githubClientId: required('GITHUB_CLIENT_ID', /^[A-Za-z0-9_]{1,100}$/), cosmosEndpoint: url.href,
    cosmosDatabase: required('COSMOS_DATABASE', /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
    ...(managedIdentityClientId === undefined ? {} : { managedIdentityClientId }), host, port: integer('PORT', 8080, 65535),
    openSignup: boolean('OPEN_SIGNUP', false), allowlistedLogins, pollAfter: integer('POLL_AFTER_SECONDS', 900, 86400),
    sweepIntervalSeconds: integer('SWEEP_INTERVAL_SECONDS', 60, 3600), sweepTimeoutSeconds: integer('SWEEP_TIMEOUT_SECONDS', 60, 300),
    shutdownGraceSeconds: integer('SHUTDOWN_GRACE_SECONDS', 10, 60), localEmulator, ...(emulatorKey === undefined ? {} : { emulatorKey }),
  };
}
