import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, Deferred } from 'effect';
import { configDomain, HistoryStore, integrationsDomain, nodeProcesses, Processes, type Decision } from '@nortuscc/machine';
import { HostedTransport, type HostedRequest } from '@nortuscc/hosted-client';
import { diffItems, itemValues, setupSourceLayer, SetupsStore } from '@nortuscc/sync';
import type { StatusSummary, SyncRevision, SyncedDecision } from '@nortuscc/hosted-protocol';
import { AgentClock, AgentStateStore, agentLayer, configuredHostedRuntime, makeSession, startAgent } from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';
import { tempRepo, json } from '../../sync/checks/support/repo.ts';

const URL = 'https://github.com/example/hosted';
const ADDITIONAL = 'https://github.com/example/additional';
const EFFORT = 'setting:claude:settings.json#effortLevel';
const HOOK = 'integration:hk';
const MODEL = 'setting:claude:settings.json#model';

test('fake three-machine service: person accepts/configures first, inert auto applies second, notify waits third', async (t) => {
  const repo = tempRepo({ 'claude/settings.keys.json': '{}' });
  t.after(() => rmSync(repo.root, { recursive: true, force: true }));
  const origin = join(repo.root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  repo.git('remote', 'add', 'origin', origin); repo.git('push', '-q', 'origin', 'main');
  const machines = [agentMachine(realpathSync(tmpdir())), agentMachine(realpathSync(tmpdir())), agentMachine(realpathSync(tmpdir()))];
  for (const m of machines) {
    t.after(() => rmSync(m.root, { recursive: true, force: true }));
    rmSync(m.paths.repo, { recursive: true });
    execFileSync('git', ['clone', '-q', origin, m.paths.repo]);
    execFileSync('git', ['-C', m.paths.repo, 'remote', 'set-url', 'origin', URL]);
  }
  const docs = { 'claude/settings.keys.json': json({ effortLevel: 'high', model: 'test-model' }), 'integrations.json': json({ version: 1,
    integrations: [{ id: 'hk', label: 'Hook', target: 'claude', type: 'hook', default: true, event: 'SessionStart', file: 'claude/hooks/test.mjs' }] }),
    'claude/hooks/test.mjs': '// inert fixture, never executed\n' };
  const commitSha = repo.commit(docs); repo.git('tag', 'v1'); repo.git('push', '-q', 'origin', 'main', 'refs/tags/v1');
  const record: SyncRevision = { setupId: 'setup1', number: 1, commitSha, tag: 'v1', changelog: '', requiredEnv: [],
    items: diffItems(itemValues({}), itemValues(docs)).map((i) => ({ id: i.itemId, kind: i.kind, change: 'added' })) };
  const authoritative: SyncedDecision[] = [];
  const reports: StatusSummary[][] = [[], [], []];
  for (const [index, m] of machines.entries()) {
    let now = Date.parse('2026-10-07T00:00:00Z'); let token: string | undefined;
    let policy: 'auto-apply' | 'notify' | 'manual' = index === 1 ? 'auto-apply' : 'notify';
    const requests: HostedRequest[] = [];
    const transport = Layer.succeed(HostedTransport, { request: (req) => Effect.sync(() => {
      requests.push(req);
      if (req.path === '/auth/device/start') return { status: 200, body: { pendingId: 'private', userCode: 'ABCD', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 120 } };
      if (req.path === '/auth/device/poll') return { status: 200, body: { accountId: 'account1', login: 'person', machineId: `machine${index}`, token: `nmt_account1_machine${index}_${'s'.repeat(43)}`, defaultPolicy: policy } };
      if (req.method === 'PATCH') {
        policy = (req.body as any).policy ?? policy;
        return { status: 200, body: { machineId: `machine${index}`, name: 'Machine', os: 'macos', agents: ['claude', 'codex'], policy, reportStatus: true, createdAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(), status: null } };
      }
      if (req.path === '/decisions') {
        const decisions = (req.body as { decisions: Decision[] }).decisions;
        for (const d of decisions) authoritative.push({ ...d, revision: d.revision!, decidedAt: new Date(now).toISOString(), machineId: `machine${index}` });
        return { status: 200, body: { seq: 1, results: decisions.map((d) => ({ setupId: d.setupId, itemId: d.itemId, outcome: 'stored' })) } };
      }
      if (req.path.startsWith('/sync?')) {
        const first = !req.path.includes('setup1%3A1');
        return { status: 200, body: { seq: authoritative.length, decisions: authoritative, revisions: first ? [record, { ...record, setupId: 'setup2' }] : [],
          machine: { policy, reportStatus: true }, setups: [{ setupId: 'setup1', name: 'Test', repoUrl: URL, latestRevision: 1 }, { setupId: 'setup2', name: 'Additional', repoUrl: ADDITIONAL, latestRevision: 1 }], pollAfter: 900 } };
      }
      if (req.path === '/machines/self/status') { reports[index]!.push(req.body as StatusSummary); return { status: 204 }; }
      assert.fail(`unexpected fake HTTP ${req.path}`);
    }) });
    const processes = Layer.effect(Processes, Effect.gen(function* () {
      const real = yield* Processes;
      return { run: (command: Parameters<Processes['Service']['run']>[0]) => {
        assert.equal(command.cmd, 'git', 'only inert Git commands reach native Processes');
        return real.run({ ...command, args: command.args.map((a) => command.args.includes('fetch') && [URL, ADDITIONAL].includes(a) ? origin : a), stderr: 'capture' });
      } };
    })).pipe(Layer.provide(nodeProcesses()));
    const clock = Layer.succeed(AgentClock, { now: Effect.sync(() => new Date(now)), random: Effect.succeed(0.5), sleep: () => Effect.never });
    const domains = (paths: typeof m.paths) => [{ ...configDomain, run: (step: Parameters<typeof configDomain.run>[0], report: Parameters<typeof configDomain.run>[1]) =>
      index === 1 && step.key.endsWith('#model') ? Effect.succeed({ ok: false, note: 'injected disk failure' }) : configDomain.run(step, report) }, integrationsDomain({ paths, env: {} })];
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      if (index === 0) yield* (yield* AgentStateStore).update((s) => ({ ...s, policy: 'manual', policySource: 'person', installedBy: 'app', appPath: '/fake/app', agentVersion: 'keep', paused: { reason: 'keep', at: new Date(now).toISOString() } }));
      const runtime = yield* configuredHostedRuntime(m.paths, { url: 'https://fake.example/v1', platform: 'darwin', transport,
        now: () => new Date(now), keychain: { read: () => Effect.succeed(token), write: (s) => Effect.sync(() => { token = s; }), remove: () => Effect.sync(() => { token = undefined; }) } }, { domains, os: 'macos' });
      yield* runtime.signIn(); now += 5000; yield* runtime.tick;
      assert.equal((yield* runtime.state).setups.length, 2, JSON.stringify(yield* runtime.state));
      if (index === 0) {
        const stored = yield* (yield* AgentStateStore).read;
        assert.equal(stored.policy, 'manual'); assert.equal(stored.installedBy, 'app'); assert.equal(stored.agentVersion, 'keep'); assert.equal(stored.appPath, '/fake/app'); assert.equal(stored.paused?.reason, 'keep');
      }
      assert.deepEqual(yield* (yield* SetupsStore).read, [], 'sign-in and sync grant no trust');
      if (index === 2) {
        const cachePath = join(m.paths.stateRoot, 'agent', 'revisions', 'account1', 'setup1.json');
        const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
        cache.revisions.push({ ...record, number: 2, tag: 'cache-ahead-unpublished', items: [] });
        writeFileSync(cachePath, JSON.stringify(cache));
      }
      yield* runtime.trust('setup1', 'cli');
      if (index === 1) yield* runtime.trust('setup2', 'cli');
      if (index === 0) {
        for (const itemId of [EFFORT, HOOK, MODEL]) yield* runtime.decide({ setupId: 'setup1', itemId, revision: 1, commit: null, decision: 'accept', decidedAt: new Date(now).toISOString(), machineId: null, source: 'local' }, 'cli');
        yield* runtime.sync;
        const handle = yield* startAgent(domains, { hosted: runtime, deferStart: true });
        const session = yield* makeSession(handle, { domains, signal: new AbortController().signal });
        yield* session.inspect('cli'); const preview = yield* session.preview([]);
        const done = Deferred.makeUnsafe<void>();
        const applied = yield* session.apply(preview.planId, 'cli', (_id, p) => { if (p.type === 'done' || p.type === 'failed' || p.type === 'cancelled') Deferred.doneUnsafe(done, Effect.void); });
        assert.equal(applied.status, 'started'); yield* Deferred.await(done);
        assert.ok(existsSync(join(m.paths.claude, 'hooks', 'test.mjs')));
      } else {
        const result = yield* runtime.runJobs;
        assert.deepEqual(result.inspection?.revision, record, 'primary stays at offered head even with additional jobs or cache-ahead data');
      }
      const last = reports[index]!.at(-1);
      assert.ok(last, JSON.stringify(yield* runtime.state));
      assert.equal(last.setups.length, index === 1 ? 2 : 1);
      if (index === 1) assert.ok(last.setups.find((s) => s.setupId === 'setup2')!.waitingForPerson.includes(EFFORT));
      assert.ok(last.setups[0]!.waitingForPerson.includes(HOOK), 'hook registration alone never claims byte adoption');
      if (index < 2) {
        assert.equal(JSON.parse(readFileSync(join(m.paths.claude, 'settings.json'), 'utf8')).effortLevel, 'high');
        assert.deepEqual([...last.setups[0]!.adopted].sort(), (index === 0 ? [EFFORT, MODEL] : [EFFORT]).sort());
        if (index === 1) assert.ok(last.setups[0]!.waitingForPerson.includes(MODEL), 'partial failure retains successful adoption but pauses remaining work');
      } else {
        assert.equal(existsSync(join(m.paths.claude, 'settings.json')), false);
        assert.ok(last.setups[0]!.waitingForPerson.includes(EFFORT));
      }
      assert.equal(JSON.stringify(last).includes('nmt_'), false);
      assert.equal(requests.filter((r) => r.path === '/decisions').length, index === 0 ? 1 : 0);
      const decisionEvents = (yield* (yield* HistoryStore).read).filter((e) => e.kind === 'decided');
      assert.ok(decisionEvents.length >= 3);
      assert.ok(decisionEvents.every((e) => e.actor === (index === 0 ? 'cli' : 'sync')));
      if (index === 1) {
        const trust = yield* (yield* SetupsStore).read;
        yield* (yield* SetupsStore).write([...trust!, { setupId: 'unavailable', accountId: 'account1', repoUrl: 'https://github.com/example/unavailable', checkout: null, trustedAt: new Date(now).toISOString() }]);
        const count = reports[index]!.length;
        const next = yield* runtime.runJobs;
        assert.deepEqual(next.inspection?.revision, record, 'additional unavailable setup does not replace primary inspection');
        assert.equal(reports[index]!.length, count, 'never upload a partial selected setup list');
      }
    })).pipe(Effect.provide(Layer.merge(agentLayer(m.paths, { processes, clock }), setupSourceLayer(m.paths, { processes })))));
  }
});
