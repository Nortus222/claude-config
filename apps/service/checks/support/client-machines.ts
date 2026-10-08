import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { TestContext } from 'node:test';
import { Effect, Layer, type Scope } from 'effect';
import { configDomain, integrationsDomain, nodeProcesses, Processes, type Decision, type MachinePathsValue } from '@nortuscc/machine';
import { AgentClock, agentLayer, configuredHostedRuntime, type AgentServices, type HostedRuntime } from '@nortuscc/agent';
import { httpTransport, type HostedDocument } from '@nortuscc/hosted-client';
import { diffItems, itemValues, setupSourceLayer, type SetupSource } from '@nortuscc/sync';
import { decodeHosted, RevisionRecordSchema, SetupRecordSchema, type RevisionPublication } from '@nortuscc/hosted-protocol';
import type { Store } from '../../src/store.ts';
import { fixture } from './service.ts';

export const EFFORT = 'setting:claude:settings.json#effortLevel';
export const HOOK = 'integration:hk';
export const HOOK_TEXT = '// INERT_PRIVATE_HOOK_TEXT, never executed\n';
export const SETTING_VALUE = 'high';
export const REPO_URL = 'https://github.com/fixture/local-config';
const FIXTURE_ORIGIN = 'https://hosted-fixture.invalid';
const docs = {
  'claude/settings.keys.json': JSON.stringify({ effortLevel: SETTING_VALUE }),
  'integrations.json': JSON.stringify({ version: 1, integrations: [{ id: 'hk', label: 'Fixture hook', target: 'claude', type: 'hook', default: true, event: 'SessionStart', file: 'claude/hooks/test.mjs' }] }),
  'claude/hooks/test.mjs': HOOK_TEXT,
};
export type HttpObservation = { readonly method: string; readonly path: string; readonly status: number; readonly body?: unknown; readonly reply?: unknown; readonly etag: string | null; readonly conditional: string | null };

export async function clientFixture(t: Pick<TestContext, 'after' | 'signal'>, options: { store?: Store['Service'] } = {}) {
  const f = await fixture(options);
  const lifetime = new AbortController();
  const activeRuns = new Set<Promise<unknown>>();
  let fixtureRoot: string | undefined;
  t.after(async () => {
    lifetime.abort();
    await Promise.allSettled([...activeRuns]);
    try { await f.close(); }
    finally { if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true }); }
  });
  const loopbackOrigin = new URL((await f.call('GET', '/v1/health')).url).origin;
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'hosted-clients-'));
  fixtureRoot = root;
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' };
  const git = (args: string[], cwd?: string) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = join(root, 'author'); mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  mkdirSync(join(repo, 'claude')); writeFileSync(join(repo, 'claude', 'settings.keys.json'), '{}');
  git(['add', '.'], repo); git(['commit', '-q', '-m', 'Baseline'], repo);
  const baselineSha = git(['rev-parse', 'HEAD'], repo);
  const origin = join(root, 'origin.git'); git(['init', '-q', '--bare', '-b', 'main', origin]);
  git(['remote', 'add', 'origin', origin], repo); git(['push', '-q', 'origin', 'main'], repo);
  for (const [path, text] of Object.entries(docs)) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); }
  git(['add', '.'], repo); git(['commit', '-q', '-m', 'Inert setting and hook'], repo);
  const commitSha = git(['rev-parse', 'HEAD'], repo); git(['tag', 'v1'], repo); git(['push', '-q', 'origin', 'main', 'refs/tags/v1'], repo);
  const items = diffItems(itemValues({}), itemValues(docs)).map((item) => ({ id: item.itemId, kind: item.kind, change: 'added' as const }));
  const register = async (token: string) => {
    const response = await f.call('POST', '/v1/setups', { name: 'Fixture config', repoUrl: REPO_URL }, token);
    assert.equal(response.status, 201); return decodeHosted(SetupRecordSchema, await response.json());
  };
  const publish = async (token: string, setupId: string, number: number, overrides: Partial<RevisionPublication> = {}) => {
    f.clock.now += 60_000;
    const response = await f.call('POST', `/v1/setups/${setupId}/revisions`, { number, commitSha, tag: 'v1', changelog: '', items, requiredEnv: [], ...overrides }, token);
    assert.equal(response.status, 201); return decodeHosted(RevisionRecordSchema, await response.json());
  };
  const machine = () => {
    const machineRoot = mkdtempSync(join(root, 'machine-')); const home = join(machineRoot, 'home'); mkdirSync(home);
    const stateRoot = join(home, '.config', 'nortuscc');
    const paths: MachinePathsValue = { repo: join(machineRoot, 'checkout'), claude: join(home, '.claude'), codex: join(home, '.codex'), codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'), stateRoot, backups: join(stateRoot, 'backups') };
    git(['clone', '-q', origin, paths.repo]); git(['reset', '-q', '--hard', baselineSha], paths.repo);
    git(['remote', 'set-url', 'origin', REPO_URL], paths.repo);
    let token: string | undefined;
    const requests: HttpObservation[] = [];
    const refused: string[] = [];
    t.after(() => assert.deepEqual(refused, [], 'no job attempted a native operation hidden by domain error handling'));
    const forward: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      assert.equal(url.origin, FIXTURE_ORIGIN, 'fetch adapter permits only the fixed fixture origin');
      const method = init?.method ?? 'GET'; const headers = new Headers(init?.headers);
      const response = await globalThis.fetch(new URL(url.pathname + url.search, loopbackOrigin), init);
      const visible = !url.pathname.startsWith('/v1/auth/');
      requests.push({ method, path: url.pathname + url.search, status: response.status,
        ...(visible && typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
        ...(visible && response.status !== 204 && response.status !== 304 ? { reply: await response.clone().json() } : {}),
        etag: response.headers.get('etag'), conditional: headers.get('if-none-match') });
      return response;
    };
    const processes = Layer.effect(Processes, Effect.gen(function* () {
      const real = yield* Processes;
      return { run: (command: Parameters<Processes['Service']['run']>[0]) => {
        if (command.cmd !== 'git') refused.push(command.cmd);
        assert.equal(command.cmd, 'git', 'installers, native service/keychain/notifications and app launches are refused');
        const args = command.args.map((arg) => command.args.includes('fetch') && arg === REPO_URL ? origin : arg);
        assert.ok(!args.some((arg) => /^(https?:|ssh:|git@)/.test(arg)), 'Git never contacts a network upstream');
        if (args.includes('fetch')) assert.ok(args.includes(origin), 'fetch must explicitly use the inert bare origin');
        if (args.includes('-C')) assert.ok(resolve(args[args.indexOf('-C') + 1]!).startsWith(machineRoot + sep));
        if (command.cwd) assert.ok(resolve(command.cwd).startsWith(machineRoot + sep), 'Git working directory belongs to this temporary machine');
        return real.run({ ...command, args: ['-c', 'core.hooksPath=/dev/null', ...args], stderr: 'capture' });
      } };
    })).pipe(Layer.provide(nodeProcesses({ env: { ...env, HOME: home } })));
    const clock = Layer.succeed(AgentClock, { now: Effect.sync(() => new Date(f.clock.now)), random: Effect.succeed(0.5), sleep: () => Effect.never });
    const domains = (value: MachinePathsValue) => [configDomain, integrationsDomain({ paths: value, env: {} })];
    const run = <A, E>(work: (runtime: HostedRuntime) => Effect.Effect<A, E, AgentServices | SetupSource | Scope.Scope>) => {
      const promise = Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const runtime = yield* configuredHostedRuntime(paths, { url: FIXTURE_ORIGIN + '/v1', platform: 'darwin', now: () => new Date(f.clock.now), transport: httpTransport(FIXTURE_ORIGIN + '/v1', { fetch: forward }),
          keychain: { read: () => Effect.succeed(token), write: (value) => Effect.sync(() => { token = value; }), remove: () => Effect.sync(() => { token = undefined; }) } }, { domains, os: 'macos' });
        return yield* work(runtime);
      })).pipe(Effect.provide(Layer.merge(agentLayer(paths, { processes, clock }), setupSourceLayer(paths, { processes })))), { signal: AbortSignal.any([t.signal, lifetime.signal]) });
      activeRuns.add(promise);
      void promise.then(() => activeRuns.delete(promise), () => activeRuns.delete(promise));
      return promise;
    };
    const document = () => JSON.parse(readFileSync(join(stateRoot, 'agent', 'sync.json'), 'utf8')) as HostedDocument;
    return { root: machineRoot, paths, run, domains, requests, document, token: () => token };
  };
  const decision = (setupId: string, itemId: string, choice: 'accept' | 'skip' = 'accept', revision = 1): Decision => ({ setupId, itemId, decision: choice, revision, commit: null, source: 'local', decidedAt: new Date(f.clock.now).toISOString(), machineId: null });
  const assertPrivateMetadata = (value: unknown, machines: ReadonlyArray<ReturnType<typeof machine>>) => {
    for (const forbidden of [root, HOOK_TEXT, 'INERT_PRIVATE_HOOK_TEXT', 'PRIVATE_OAUTH_TOKEN', 'PRIVATE_DEVICE_CODE', ...machines.map((m) => m.token()).filter((value): value is string => value !== undefined)]) {
      const encoded = JSON.stringify(forbidden).slice(1, -1);
      assert.equal(JSON.stringify(value).includes(encoded), false); assert.equal(JSON.stringify(f.diagnostics).includes(encoded), false);
    }
    assert.equal(JSON.stringify(value).includes('"effortLevel":"high"'), false);
    assert.equal(JSON.stringify(value).includes(JSON.stringify(SETTING_VALUE)), false);
    assert.equal(JSON.stringify(f.diagnostics).includes(JSON.stringify(SETTING_VALUE)), false);
    assert.equal(JSON.stringify(value).includes('tokenHash'), false);
  };
  return { ...f, root, repo, origin, commitSha, items, machine, register, publish, decision, assertPrivateMetadata };
}
