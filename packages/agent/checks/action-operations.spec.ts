import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Effect } from 'effect';
import { configDomain, Fs, FsFailed, integrationsDomain, OverridesStore, skillsDomain, MCP_ROUTING_BLOCK_ID, MCP_ROUTING_BYTES } from '@nortuscc/machine';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import { startAgent, makeSession, SetupSource, type AgentSession, type AgentDomains } from '../src/index.ts';
import { decodeOperationInput, decodeOperationOutput, type OperationChange } from '../src/operations/index.ts';
import { operationDigest } from '../src/runs.ts';
import { agentMachine } from './support/agent-machine.ts';
import { setupFixture } from './support/setup-fixture.ts';

const C = 'config:claude:CLAUDE.md'; const X = 'config:codex:AGENTS.md';
const THEME = 'config:claude:settings.json#theme'; const EFFORT = 'config:claude:settings.json#effortLevel';
const fixture = () => {
  const m = agentMachine();
  const setup = setupFixture(join(m.root, 'setup'), { headFiles: { 'claude/CLAUDE.md': '# Claude\n', 'codex/AGENTS.md': '# Codex\n' } });
  const within = <A, E>(body: (session: AgentSession) => Effect.Effect<A, E>, injection: { fs?: (fs: Fs['Service']) => Fs['Service']; domains?: AgentDomains } = {}) => m.run(Effect.scoped(Effect.gen(function* () {
    const store = yield* OverridesStore; const fs = yield* Fs;
    const compose = <T extends { repo: string }>(snapshot: T) => Effect.gen(function* () {
      const desired = yield* loadProfile(snapshot.repo, { overrides: yield* store.read }).pipe(Effect.provide(nodeFiles));
      return { ...snapshot, desired };
    });
    const source: SetupSource['Service'] = { ...setup.service, current: setup.service.current.pipe(Effect.flatMap(compose), Effect.orDie) };
    const domains: AgentDomains = injection.domains ?? (paths => [configDomain, integrationsDomain({ paths, env: {}, installerOutput: 'capture' })]);
    return yield* Effect.gen(function* () {
      const handle = yield* startAgent(domains, { deferStart: true });
      const session = yield* makeSession(handle, { signal: new AbortController().signal, domains });
      yield* session.inspect('mcp');
      return yield* body(session);
    }).pipe(Effect.provideService(SetupSource, source), Effect.provideService(Fs, injection.fs?.(fs) ?? fs), Effect.provideService(OverridesStore, store));
  })), setup.source);
  return { m, setup, within };
};
const apply = (session: AgentSession, change: unknown, requestId = 'action') => Effect.gen(function* () {
  const p = yield* session.previewChange(change as OperationChange); decodeOperationOutput('previewChange', p);
  const req = { planId: p.planId, requestId, inputDigest: operationDigest(p.planId), actor: 'mcp' as const };
  const accepted = yield* session.runs.submit(req);
  yield* Effect.callback<void>(resume => { const off = session.runs.subscribe(accepted.runId, run => { if (run.result) resume(Effect.void); }); return Effect.sync(off); });
  while (yield* session.running) yield* Effect.yieldNow;
  const done = yield* session.runs.get(accepted.runId); decodeOperationOutput('getRun', done);
  assert.equal((yield* session.runs.submit(req)).runId, accepted.runId);
  return done;
});

test('selected reconcile and config restoration use strict existing operation schemas', () => {
  for (const change of [{ kind: 'reconcile', only: [C], targets: ['claude'], declined: ['hooks'], force: true }, { kind: 'uninstallConfig', only: [C], targets: ['claude'], force: true }]) {
    assert.deepEqual(decodeOperationInput('previewChange', { change }).change, change);
  }
  for (const change of [{ kind: 'uninstallConfig', only: [C], declined: ['hooks'] }, { kind: 'reconcile', only: [C], targets: ['unknown'] }, { kind: 'reconcile', only: [C], declined: ['unknown'] }]) assert.throws(() => decodeOperationInput('previewChange', { change }));
});

test('config target selection and whole-document uninstall never select another target or integration', async () => {
  const f = fixture();
  await f.within(session => Effect.gen(function* () {
    const done = yield* apply(session, { kind: 'reconcile', only: [C, X, THEME, EFFORT], targets: ['claude'] });
    assert.equal(done.state, 'succeeded'); assert.equal(f.m.read(join(f.m.paths.codex, 'AGENTS.md')), undefined);
    yield* session.inspect('mcp');
    assert.equal((yield* apply(session, { kind: 'reconcile', only: [X], targets: ['codex'] }, 'codex')).state, 'succeeded');
    yield* session.inspect('mcp');
    const removed = yield* apply(session, { kind: 'uninstallConfig', only: [THEME, X], targets: ['claude'] }, 'remove');
    assert.equal(removed.state, 'succeeded'); assert.deepEqual(removed.parity?.committedKeys, ['config:claude:settings.json']);
    assert.equal(f.m.read(join(f.m.paths.claude, 'settings.json')), undefined); assert.equal(f.m.read(join(f.m.paths.claude, 'CLAUDE.md')), '# Claude\n');
    assert.equal(f.m.read(join(f.m.paths.codex, 'AGENTS.md')), '# Codex\n');
  }));
});

test('declined integration categories suppress installation and declared hooks use their existing owner', async () => {
  const f = fixture();
  await f.within(session => Effect.gen(function* () {
    const declined = yield* session.previewChange({ kind: 'reconcile', only: ['integration:hk'], declined: ['hooks'] });
    assert.deepEqual(declined.plan.steps, []); assert.ok(declined.plan.skipped.some(item => item.reason === 'declined (--no-hooks)'));
    const done = yield* apply(session, { kind: 'reconcile', only: ['integration:hk'], targets: ['claude'] });
    assert.equal(done.state, 'succeeded');
    const settings = f.m.read(join(f.m.paths.claude, 'settings.json'))!; assert.match(settings, /SessionStart/);
    const skillPath = join(f.m.paths.agentsSkills, 'retained', 'SKILL.md'); f.m.write(skillPath, '# retained');
    yield* session.inspect('mcp');
    assert.equal((yield* Effect.flip(session.previewChange({ kind: 'uninstallConfig', only: ['integration:hk'] }))).code, 'UNKNOWN_KEY');
    const config = yield* apply(session, { kind: 'uninstallConfig', only: [THEME] }, 'config-only');
    assert.equal(config.state, 'succeeded'); assert.equal(f.m.read(join(f.m.paths.claude, 'settings.json')), settings); assert.equal(f.m.read(skillPath), '# retained');
  }));
});

test('unknown selections refuse without creating a run or exposing the unknown key', async () => {
  const f = fixture();
  await f.within(session => Effect.gen(function* () {
    for (const kind of ['reconcile', 'uninstallConfig'] as const) {
      const error = yield* Effect.flip(session.previewChange({ kind, only: ['sk-unknownfixture'] }));
      assert.equal(error.code, 'UNKNOWN_KEY'); assert.doesNotMatch(error.message, /sk-/);
    }
    assert.deepEqual((yield* session.runs.list({ limit: 10 })).runs, []);
  }));
});

test('selecting one settings key retains the whole document changed-key guard', async () => {
  const f = fixture();
  await f.within(session => Effect.gen(function* () {
    assert.equal((yield* apply(session, { kind: 'reconcile', only: [THEME, EFFORT] })).state, 'succeeded');
    const path = join(f.m.paths.claude, 'settings.json'); f.m.write(path, '{"theme":"dark","effortLevel":"edited","mine":1}');
    yield* session.inspect('mcp');
    const preview = yield* session.previewChange({ kind: 'uninstallConfig', only: [THEME] });
    assert.deepEqual(preview.plan.steps, []); assert.deepEqual(preview.plan.skipped, [{ key: 'config:claude:settings.json', reason: 'changed since nortuscc wrote it' }]);
    const done = yield* apply(session, { kind: 'uninstallConfig', only: [THEME], force: true }, 'forced');
    assert.equal(done.state, 'succeeded'); assert.deepEqual(JSON.parse(f.m.read(path)!), { mine: 1 });
  }));
});

test('malformed JSON requires force and the existing restoration owner keeps a backup', async () => {
  const f = fixture();
  await f.within(session => Effect.gen(function* () {
    yield* apply(session, { kind: 'reconcile', only: [THEME] });
    const path = join(f.m.paths.claude, 'settings.json'); f.m.write(path, '{ malformed');
    yield* session.inspect('mcp');
    const preview = yield* session.previewChange({ kind: 'uninstallConfig', only: ['config:claude:settings.json'] }); assert.deepEqual(preview.plan.steps, []);
    const done = yield* apply(session, { kind: 'uninstallConfig', only: ['config:claude:settings.json'], force: true }, 'forced-json');
    assert.equal(done.state, 'succeeded'); assert.ok(done.parity!.backupIds.length); assert.equal(f.m.read(path), undefined);
    assert.equal(f.m.read(join(f.m.paths.backups, done.parity!.backupIds[0]!, 'claude', 'uninstall', 'settings.json')), '{ malformed');
  }));
});

test('uninstall restores trusted originals but never restores a pre-cutoff backup', async () => {
  for (const older of [false, true]) {
    const f = fixture(); const path = join(f.m.paths.claude, 'CLAUDE.md'); f.m.write(path, '# original\n');
    if (older) f.m.write(join(f.m.paths.backups, 'nortuscc-2026-10-05T12-00-00-000Z', 'claude', 'CLAUDE.md'), '# untrusted\n');
    await f.within(session => Effect.gen(function* () {
      yield* apply(session, { kind: 'reconcile', only: [C] }); yield* session.inspect('mcp');
      const done = yield* apply(session, { kind: 'uninstallConfig', only: [C] }, 'restore');
      assert.equal(done.state, 'succeeded'); assert.equal(f.m.read(path), older ? undefined : '# original\n');
    }));
  }
});

test('stale selected instruction bytes refuse before acceptance even under force', async () => {
  const f = fixture();
  await f.within(session => Effect.gen(function* () {
    const p = yield* session.previewChange({ kind: 'reconcile', only: [C], force: true });
    f.m.write(join(f.m.paths.claude, 'CLAUDE.md'), '# external edit\n');
    const error = yield* Effect.flip(session.runs.submit({ planId: p.planId, requestId: 'stale', inputDigest: operationDigest(p.planId), actor: 'mcp' }));
    assert.equal(error.code, 'STALE_PLAN'); assert.deepEqual((yield* session.runs.list({ limit: 10 })).runs, []);
    assert.equal(f.m.read(join(f.m.paths.claude, 'CLAUDE.md')), '# external edit\n');
  }));
});

test('partial config execution preserves the first committed key and same-request recovery without replay', async () => {
  const f = fixture(); let failed = false; f.m.write(join(f.m.paths.claude, 'CLAUDE.md'), '# original\n');
  await f.within(session => Effect.gen(function* () {
    const done = yield* apply(session, { kind: 'reconcile', only: [C, X], targets: ['claude', 'codex'] });
    assert.ok(failed); assert.equal(done.state, 'failed'); assert.equal(done.parity?.state, 'needsInspection');
    assert.deepEqual(done.parity?.committedKeys, [C]); assert.deepEqual(done.parity?.remainingKeys, [X]); assert.ok(done.parity?.backupIds.length);
    assert.equal(f.m.read(join(f.m.paths.claude, 'CLAUDE.md')), '# Claude\n');
    // The failed step's real cause reaches the run message, its note and History; credentials do not.
    assert.equal(done.result?.status, 'failed');
    assert.match(done.result && 'message' in done.result ? done.result.message : '', /^Couldn't apply config:codex:AGENTS\.md: write \S+AGENTS\.md: EACCES: permission denied token \[redacted\]$/);
    assert.match(done.steps.find(step => step.key === X)?.note ?? '', /AGENTS\.md: EACCES: permission denied/);
    assert.doesNotMatch(JSON.stringify(done), /ghp_/);
  }), { fs: fs => ({ ...fs, writeTextAtomic: (path, text) => path === join(f.m.paths.codex, 'AGENTS.md') ? Effect.suspend(() => { failed = true; return Effect.fail(new FsFailed({ op: 'write', path, reason: 'EACCES: permission denied token ghp_abcdefghijklmnop' })); }) : fs.writeTextAtomic(path, text) }) });
  const history = JSON.stringify(await f.m.events());
  assert.match(history, /EACCES: permission denied/); assert.doesNotMatch(history, /ghp_/);
});

const routingFixture = () => {
  const f = fixture(); const path = join(f.m.paths.claude, 'CLAUDE.md');
  f.m.write(path, '# mine\n' + MCP_ROUTING_BYTES);
  f.m.write(join(f.m.paths.stateRoot, 'state.json'), JSON.stringify({ version: 1, repo: null, files: {}, mcpRouting: { version: 1, files: { 'claude:CLAUDE.md': { fileId: 'claude:CLAUDE.md', blockId: MCP_ROUTING_BLOCK_ID, bytes: MCP_ROUTING_BYTES, state: 'active' } } } }));
  return { ...f, path };
};
test('force never weakens edited routing ownership guards', async () => {
  const f = routingFixture(); const edited = '# mine\n' + MCP_ROUTING_BYTES.replace('For nortuscc', 'Edited nortuscc'); f.m.write(f.path, edited);
  await f.within(session => Effect.gen(function* () {
    for (const kind of ['reconcile', 'uninstallConfig'] as const) {
      const p = yield* session.previewChange({ kind, only: [C], force: true }); assert.deepEqual(p.plan.steps, []);
    }
    assert.equal(f.m.read(f.path), edited); assert.equal(JSON.parse(f.m.read(join(f.m.paths.stateRoot, 'state.json'))!).mcpRouting.files['claude:CLAUDE.md'].state, 'active');
  }));
});
test('a routing release committed before restoration failure remains recoverable through getRun', async () => {
  const f = routingFixture(); let writes = 0;
  const saved = await f.within(session => Effect.gen(function* () {
    const done = yield* apply(session, { kind: 'uninstallConfig', only: [C], force: true });
    assert.equal(writes, 1); assert.equal(done.state, 'failed'); assert.equal(done.parity?.state, 'needsInspection');
    assert.deepEqual(done.parity?.committedKeys, [C]); assert.deepEqual(done.parity?.remainingKeys, []); assert.ok(done.parity!.backupIds.length);
    assert.equal(JSON.parse(f.m.read(join(f.m.paths.stateRoot, 'state.json'))!).mcpRouting.files['claude:CLAUDE.md'].state, 'released');
    assert.match(JSON.stringify(done.result), /Couldn't apply config:claude:CLAUDE\.md: write \S+CLAUDE\.md: ROUTING_EXCEPTION/);
    assert.equal(f.m.read(join(f.m.paths.backups, done.parity!.backupIds[0]!, 'claude', 'uninstall', 'CLAUDE.md')), '# mine\n' + MCP_ROUTING_BYTES);
    return done;
  }), { fs: fs => ({ ...fs, writeTextAtomic: (path, text) => path === f.path ? Effect.suspend(() => { writes++; return Effect.fail(new FsFailed({ op: 'write', path, reason: 'ROUTING_EXCEPTION' })); }) : fs.writeTextAtomic(path, text) }) });
  await f.within(session => Effect.gen(function* () {
    const recovered = yield* session.runs.get(saved.runId);
    assert.deepEqual(recovered.parity, saved.parity); assert.equal(recovered.state, 'failed');
    const same = yield* session.runs.submit({ planId: saved.intent.planId, requestId: saved.intent.requestId, inputDigest: saved.intent.inputDigest, actor: 'mcp' });
    assert.equal(same.runId, saved.runId); assert.equal(writes, 1);
  }));
  assert.match(JSON.stringify(await f.m.events()), /ROUTING_EXCEPTION/);
});

test('every projected owner identity and destination is checked before retaining an action', async () => {
  for (const field of ['key', 'touches'] as const) {
    const f = fixture();
    await f.within(session => Effect.gen(function* () {
      const error = yield* Effect.flip(session.previewChange({ kind: 'reconcile', only: [C], force: true }));
      assert.equal(error.code, 'OVERSIZED'); assert.doesNotMatch(error.message, /sk-/); assert.deepEqual((yield* session.runs.list({ limit: 10 })).runs, []);
    }), { domains: () => [{ ...configDomain, steps: (items, selection, kind, desired) => {
      const result = configDomain.steps(items, selection, kind, desired);
      return { ...result, steps: result.steps.map(step => ({ ...step, [field]: field === 'key' ? 'sk-ownerfixture' : ['claude:sk-destinationfixture'] })) };
    } }] });
  }
});

test('reconcile reports the audited additions repair prerequisite without invoking a legacy installer', async () => {
  const f = fixture();
  f.m.write(join(f.m.paths.stateRoot, 'overrides.json'), JSON.stringify({ version: 2, skillAdditions: [{ source: 'a/b', name: 'personal', targets: ['claude'] }] }));
  await f.within(session => Effect.gen(function* () {
    const p = yield* session.previewChange({ kind: 'reconcile', only: ['skill:personal'], targets: ['claude'] });
    assert.deepEqual(p.plan.steps, []);
    assert.ok(p.plan.skipped.some(row => row.key === 'skill:personal' && row.reason === 'Resolve and preview this skill addition to repair or update it with native verification'));
    const done = yield* apply(session, { kind: 'reconcile', only: ['skill:personal'], targets: ['claude'] });
    assert.equal(done.state, 'succeeded'); assert.deepEqual(done.parity?.committedKeys, []);
    assert.equal(f.m.read(join(f.m.paths.agentsSkills, 'personal', 'SKILL.md')), undefined);
  }), { domains: () => [skillsDomain] });
});
