import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import { RunStore, RunStoreError, type RunReceipt } from '../src/run-store.ts';
import { AgentSkillInstaller } from '../src/skill-installer.ts';
import { join } from 'node:path';
import { Deferred, Effect } from 'effect';
import { configDomain, OverridesStore, Fs, FsFailed, HistoryStore, MCP_ROUTING_BLOCK_ID, MCP_ROUTING_BYTES, MachinePaths, StateStore, validMcpRouting } from '@nortuscc/machine';
import { startAgent, makeSession, SetupSource, type AgentSession, type JobInspection } from '../src/index.ts';
import { decodeOperationInput, decodeOperationOutput } from '../src/operations/index.ts';
import { operationDigest } from '../src/runs.ts';
import { agentMachine } from './support/agent-machine.ts';
import { setupFixture } from './support/setup-fixture.ts';

test('intent read and mutation have strict bounded shared schemas', () => {
  assert.deepEqual(decodeOperationInput('inspectIntent', { section: 'settings' }), { scope: { kind: 'machine' }, section: 'settings', limit: 50 });
  for (const input of [{ section: 'settings', limit: 101 }, { section: 'settings', raw: true }]) assert.throws(() => decodeOperationInput('inspectIntent', input));
  assert.throws(() => decodeOperationInput('previewChange', { change: { kind: 'machineIntent', patch: { kind: 'manageConfig', action: 'reset', value: true } } }));
});
test('effective read pages refuse old generations and intent apply recovers the same run without installation', async () => {
  const m = agentMachine(); const fixture = setupFixture(join(m.root, 'setup')); let installs = 0;
  await m.run(Effect.scoped(Effect.gen(function* () {
    const handle = yield* startAgent(() => [{ ...configDomain, run: () => Effect.sync(() => { installs++; return { ok: true, note: 'Unexpected physical effect' }; }) }], { deferStart: true });
    const session = yield* makeSession(handle, { signal: new AbortController().signal, domains: () => [] });
    yield* session.inspect('mcp');
    const page = yield* session.inspectIntent(decodeOperationInput('inspectIntent', { section: 'files', limit: 1 }));
    assert.ok(page.nextCursor); decodeOperationOutput('inspectIntent', page);
    yield* session.inspect('mcp');
    assert.equal((yield* Effect.flip(session.inspectIntent(decodeOperationInput('inspectIntent', { section: 'files', cursor: page.nextCursor!, limit: 1 })))).code, 'UNKNOWN_PLAN');
    const p = yield* session.previewChange({ kind: 'machineIntent', patch: { kind: 'manageConfig', action: 'set', value: false } });
    assert.equal(p.change.kind, 'machineIntent'); assert.equal(p.plan.kind, 'operation');
    const req = { planId: p.planId, requestId: 'intent-retry', inputDigest: operationDigest(p.planId), actor: 'mcp' as const };
    const accepted = yield* session.runs.submit(req);
    const done = Deferred.makeUnsafe<void>();
    const off = session.onProgress((id, event) => { if (id === accepted.runId && ['done', 'failed', 'cancelled'].includes(event.type)) Deferred.doneUnsafe(done, Effect.void); });
    if (yield* session.running) yield* Deferred.await(done); off();
    const run = yield* session.runs.submit(req);
    assert.equal(run.runId, accepted.runId); assert.equal(run.state, 'succeeded'); assert.equal(run.intentSaved, true); assert.equal(run.parity?.state, 'committed');
    assert.equal((yield* (yield* OverridesStore).read).value.manageConfig, false); assert.equal(installs, 0);
  })), fixture.source);
});


type Injection = { fs?: (fs: Fs['Service']) => Fs['Service']; state?: (state: StateStore['Service']) => StateStore['Service']; receipt?: (r: RunReceipt) => boolean; history?: boolean; overrides?: (store: OverridesStore['Service']) => OverridesStore['Service']; inspection?: (value: JobInspection) => JobInspection; paths?: (paths: MachinePaths['Service']) => MachinePaths['Service'] };
const finishIntent = (session: AgentSession, id: string) => Effect.callback<void>(resume => {
  const off = session.runs.subscribe(id, run => { if (run.result) resume(Effect.void); }); return Effect.sync(off);
});
const intentFixture = (routes = false, legacy = false) => {
  const m = agentMachine(); const fixture = setupFixture(join(m.root, 'setup'));
  const overridePath = join(m.paths.stateRoot, 'overrides.json');
  const statePath = join(m.paths.stateRoot, 'state.json');
  const claude = join(m.paths.claude, 'CLAUDE.md'); const codex = join(m.paths.codex, 'AGENTS.md');
  const original = '{ "version": 2, "future": { "preserve": true } }';
  if (!legacy) m.write(overridePath, original);
  if (routes) {
    m.write(statePath, JSON.stringify({ version: 1, repo: null, files: {}, ...(legacy ? { configTargets: ['claude', 'codex'] } : {}), mcpRouting: { version: 1, files: Object.fromEntries(['claude:CLAUDE.md', 'codex:AGENTS.md'].map(fileId => [fileId, { fileId, blockId: MCP_ROUTING_BLOCK_ID, bytes: MCP_ROUTING_BYTES, state: 'active' }])) } }));
    m.write(claude, 'Claude prose\n' + MCP_ROUTING_BYTES); m.write(codex, 'Codex prose\n' + MCP_ROUTING_BYTES);
  }
  let installs = 0;
  const within = <A, E>(body: (session: AgentSession) => Effect.Effect<A, E>, injection: Injection = {}) => m.run(Effect.scoped(Effect.gen(function* () {
    const rawStore = yield* OverridesStore; const store = injection.overrides?.(rawStore) ?? rawStore; const paths = yield* MachinePaths; const fs = yield* Fs; const state = yield* StateStore; const receipts = yield* RunStore; const history = yield* HistoryStore;
    const compose = <T extends { repo: string }>(snapshot: T) => Effect.gen(function* () {
      return { ...snapshot, desired: yield* loadProfile(snapshot.repo, { overrides: yield* store.read }).pipe(Effect.provide(nodeFiles)) };
    }).pipe(Effect.orDie);
    const source: SetupSource['Service'] = { ...fixture.service, current: fixture.service.current.pipe(Effect.flatMap(compose)), load: revision => fixture.service.load(revision).pipe(Effect.flatMap(compose)), effective: decisions => fixture.service.effective(decisions).pipe(Effect.flatMap(value => Effect.map(compose(value.effective), effective => ({ ...value, effective })))) };
    return yield* Effect.gen(function* () {
      const handle = yield* startAgent(() => [], { deferStart: true });
      const installer = yield* AgentSkillInstaller;
      const session = yield* makeSession({ ...handle, inspection: handle.inspection.pipe(Effect.map(value => value && injection.inspection ? injection.inspection(value) : value)) }, { signal: new AbortController().signal, domains: () => [] }).pipe(
        Effect.provideService(MachinePaths, injection.paths?.(paths) ?? paths),
        Effect.provideService(Fs, injection.fs?.(fs) ?? fs), Effect.provideService(StateStore, injection.state?.(state) ?? state), Effect.provideService(OverridesStore, store),
        Effect.provideService(AgentSkillInstaller, { prepare: (...args) => { installs++; return installer.prepare(...args); } }),
        Effect.provideService(RunStore, { ...receipts, write: r => injection.receipt?.(r) ? Effect.fail(new RunStoreError('injected receipt failure')) : receipts.write(r) }),
        Effect.provideService(HistoryStore, { ...history, append: e => injection.history && e.kind === 'operation-checkpoint' && e.committedKeys.length > 0 ? Effect.fail(new FsFailed({ op: 'write', path: 'history', reason: 'injected failure' })) : history.append(e) }),
      );
      yield* session.inspect('mcp');
      const result = yield* body(session); assert.equal(installs, 0); return result;
    }).pipe(Effect.provideService(SetupSource, source));
  })), fixture.source);
  const apply = (session: AgentSession, patch: Parameters<AgentSession['previewChange']>[0] & { kind: 'machineIntent' }) => Effect.gen(function* () {
    const p = yield* session.previewChange(patch);
    const request = { planId: p.planId, requestId: 'intent', inputDigest: operationDigest(p.planId), actor: 'mcp' as const };
    const accepted = yield* session.runs.submit(request); yield* finishIntent(session, accepted.runId);
    while (yield* session.running) yield* Effect.yieldNow;
    const done = yield* session.runs.submit(request); assert.equal(done.runId, accepted.runId); return done;
  });
  return { m, setup: fixture, within, apply, overridePath, statePath, claude, codex, original };
};
const managementOff = { kind: 'machineIntent', patch: { kind: 'manageConfig', action: 'set', value: false } } as const;

test('intent saves unknown v2 bytes with exact private backup and releases both routing receipts', async () => {
  const f = intentFixture(true);
  await f.within(session => Effect.gen(function* () {
    const done = yield* f.apply(session, managementOff);
    assert.equal(done.state, 'succeeded'); assert.equal(done.intentSaved, true); assert.equal(done.parity?.committedKeys.length, 3);
    assert.equal(f.m.read(f.claude), 'Claude prose\n'); assert.equal(f.m.read(f.codex), 'Codex prose\n');
    const ownership: unknown = JSON.parse(f.m.read(f.statePath)!).mcpRouting; assert.ok(validMcpRouting(ownership));
    assert.deepEqual(Object.values(ownership.files).map(r => r.state), ['released', 'released']);
    assert.deepEqual(JSON.parse(f.m.read(f.overridePath)!).future, { preserve: true });
    const backup = join(f.m.paths.backups, done.parity!.backupIds[0]!, 'overrides.json');
    assert.equal(readFileSync(backup, 'utf8'), f.original); assert.equal(statSync(backup).mode & 0o777, 0o600);
  }));
});
test('first intent save previews future provenance without migrating and retains legacy target choices', async () => {
  const f = intentFixture(true, true); const before = f.m.read(f.statePath);
  await f.within(session => Effect.gen(function* () {
    const p = yield* session.previewChange(managementOff); assert.equal(f.m.read(f.overridePath), undefined); assert.equal(f.m.read(f.statePath), before);
    const done = yield* f.apply(session, managementOff); assert.equal(done.state, 'succeeded');
    const saved = JSON.parse(f.m.read(f.overridePath)!); assert.deepEqual(saved.configTargets, ['claude', 'codex']);
    yield* session.inspect('mcp');
    const read = yield* session.inspectIntent(decodeOperationInput('inspectIntent', { section: 'configuration' }));
    assert.equal(read.items[0]!.kind, 'manageConfig'); assert.equal('from' in read.items[0]! && read.items[0].from.source, f.overridePath); assert.ok(p.plan.steps.length > 0);
  }));
});
test('edited active routing is preserved while owned management is released; enable never enrolls routing', async () => {
  const f = intentFixture(true); const edited = 'mine\n' + MCP_ROUTING_BYTES.replace('For nortuscc', 'Edited nortuscc'); f.m.write(f.claude, edited);
  await f.within(session => Effect.gen(function* () {
    const done = yield* f.apply(session, managementOff); assert.equal(done.state, 'succeeded'); assert.equal(f.m.read(f.claude), edited);
  }));
  const g = intentFixture(); g.m.write(g.overridePath, '{"version":2,"manageConfig":false}');
  await g.within(session => Effect.gen(function* () {
    const done = yield* g.apply(session, { kind: 'machineIntent', patch: { kind: 'manageConfig', action: 'reset' } });
    assert.equal(done.state, 'succeeded'); assert.equal(done.parity!.committedKeys.length, 1); assert.equal(g.m.read(g.statePath), undefined); assert.equal(g.m.read(g.claude), undefined);
  }));
});
for (const race of ['override-backup', 'between-releases', 'ownership-persistence'] as const) test(`intent retains saved and partial routing evidence after external edit at ${race}`, async () => {
  const f = intentFixture(true); let injected = false;
  const edited = 'external instructions\n';
  const injection: Injection = race === 'ownership-persistence' ? { state: real => ({ ...real, write: next => real.write(next).pipe(Effect.tap(() => Effect.sync(() => {
    if (!injected) { injected = true; f.m.write(f.claude, edited); }
  }))) }) } : { fs: real => ({ ...real,
    stat: path => real.stat(path).pipe(Effect.tap(() => Effect.sync(() => { if (!injected && race === 'override-backup' && path === f.overridePath) { injected = true; f.m.write(f.claude, edited); } }))),
    writeTextAtomic: (path, text) => real.writeTextAtomic(path, text).pipe(Effect.tap(() => Effect.sync(() => { if (!injected && race === 'between-releases' && path === f.claude) { injected = true; f.m.write(f.codex, edited); } }))),
  }) };
  await f.within(session => Effect.gen(function* () {
    const done = yield* f.apply(session, managementOff); assert.ok(injected); assert.equal(done.state, 'failed'); assert.equal(done.intentSaved, true); assert.equal(done.intentState, 'saved'); assert.equal(done.parity?.state, 'needsInspection');
    assert.deepEqual(done.parity?.committedKeys, race === 'override-backup' ? ['intent:overrides'] : ['intent:overrides', 'intent:routing:claude:CLAUDE.md']);
    assert.equal(f.m.read(race === 'between-releases' ? f.codex : f.claude), edited);
    assert.ok(done.parity!.backupIds.length > 0);
    if (race === 'ownership-persistence') {
      assert.equal(done.parity?.kind, 'machineIntent');
      if (done.parity?.kind === 'machineIntent') assert.deepEqual(done.parity.routingEffects[0], { fileId: 'claude:CLAUDE.md', state: 'observed', intentChanged: true, instructionsChanged: false, outcome: 'conflict' });
    }
  }), injection);
});
for (const failure of ['receipt', 'history', 'both'] as const) test(`saved intent survives ${failure} checkpoint failure without same-request replay`, async () => {
  const f = intentFixture(); let writes = 0;
  const stderr: string[] = []; const previous = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await f.within(session => Effect.gen(function* () {
      const done = yield* f.apply(session, { kind: 'machineIntent', patch: { kind: 'setting', fileId: 'claude:settings.json', key: 'theme', action: 'set', value: 'light' } });
      assert.equal(done.state, failure === 'history' ? 'failed' : 'interrupted'); assert.equal(done.intentSaved, true); assert.equal(done.intentState, 'saved'); assert.equal(done.parity?.state, 'needsInspection'); assert.deepEqual(done.parity?.committedKeys, ['intent:overrides']); assert.ok(done.parity!.backupIds.length > 0); assert.equal(writes, 1);
    }), { receipt: failure !== 'history' ? r => r.view.intentSaved : undefined, history: failure !== 'receipt', overrides: real => ({ ...real, write: (...args) => { writes++; return real.write(...args); } }) });
    assert.deepEqual(stderr, []);
  } finally { process.stderr.write = previous; }
});
test('stale overrides or malformed known documents refuse before writing', async () => {
  const f = intentFixture();
  await f.within(session => Effect.gen(function* () {
    const p = yield* session.previewChange(managementOff);
    f.m.write(f.overridePath, '{"version":2,"manageConfig":true}');
    assert.equal((yield* Effect.flip(session.runs.submit({ planId: p.planId, requestId: 'stale', inputDigest: operationDigest(p.planId), actor: 'mcp' }))).code, 'UNKNOWN_PLAN');
    f.m.write(f.overridePath, '{"version":2,"skills":{"broken":"invalid"}}');
    assert.equal((yield* Effect.flip(session.previewChange(managementOff))).code, 'PROFILE_INVALID');
    assert.equal(f.m.read(f.overridePath), '{"version":2,"skills":{"broken":"invalid"}}');
  }));
});
test('safe intent reads never reflect integration bodies or issue messages and reject authorizing value limits', async () => {
  const f = intentFixture();
  await f.within(session => Effect.gen(function* () {
    for (const section of ['configuration', 'files', 'settings', 'skills', 'integrations', 'issues'] as const) {
      const page = yield* session.inspectIntent(decodeOperationInput('inspectIntent', { section })); decodeOperationOutput('inspectIntent', page);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 65536); assert.doesNotMatch(JSON.stringify(page), /command|env|injected/);
    }
  }));
});
test('disable and declaration removal retain installed shared bytes', async () => {
  for (const kind of ['skill', 'removeSkillDeclaration'] as const) {
    const f = intentFixture();
    f.m.write(f.overridePath, JSON.stringify({ version: 2, skillAdditions: [{ source: 'a/b', name: 'personal', targets: ['claude'] }], skills: { personal: true } }));
    const installed = join(f.m.paths.agentsSkills, 'personal', 'SKILL.md'); f.m.write(installed, '# shared skill bytes');
    await f.within(session => Effect.gen(function* () {
      const done = yield* f.apply(session, { kind: 'machineIntent', patch: kind === 'skill' ? { kind, source: 'a/b', name: 'personal', action: 'disable' } : { kind, source: 'a/b', name: 'personal' } });
      assert.equal(done.state, 'succeeded'); assert.equal(f.m.read(installed), '# shared skill bytes');
      const saved = JSON.parse(f.m.read(f.overridePath)!); assert.equal(saved.skills.personal, kind === 'skill' ? false : undefined);
    }));
  }
});
test('receipt pending failure prevents any override write and later retries never repeat it', async () => {
  const f = intentFixture(); let writes = 0;
  await f.within(session => Effect.gen(function* () {
    const done = yield* f.apply(session, managementOff); assert.equal(writes, 0); assert.equal(done.intentSaved, false); assert.equal(done.parity?.state, 'needsInspection'); assert.equal(f.m.read(f.overridePath), f.original);
  }), { receipt: r => r.view.parity?.state === 'needsInspection', overrides: real => ({ ...real, write: (...args) => { writes++; return real.write(...args); } }) });
});
test('integration read projects no command or environment bodies; issues use constant diagnostics', async () => {
  const f = intentFixture(); const integrationPath = join(f.setup.dirs['b'.repeat(40)]!, 'integrations.json');
  f.m.write(integrationPath, JSON.stringify({ version: 1, integrations: [{ id: 'safe-mcp', label: 'safe MCP', target: 'codex', type: 'mcp', default: true, command: 'PRIVATE_COMMAND_BODY', env: { PRIVATE_NAME: 'PRIVATE_ENV_BODY' }, requiresEnv: ['PRIVATE_NAME'] }] }));
  await f.within(session => Effect.gen(function* () {
    const page = yield* session.inspectIntent(decodeOperationInput('inspectIntent', { section: 'integrations' }));
    assert.equal(page.items.length, 1); assert.doesNotMatch(JSON.stringify(page), /PRIVATE_|command|"env"/);
    assert.match(JSON.stringify(page), /environment prerequisites/); assert.equal(page.items[0]!.kind, 'integration');
  }));
  f.m.write(integrationPath, '{"version":"PRIVATE_EXCEPTION_BODY","integrations":[]}');
  await f.within(session => Effect.gen(function* () {
    const page = yield* session.inspectIntent(decodeOperationInput('inspectIntent', { section: 'issues' }));
    assert.ok(page.items.length); assert.doesNotMatch(JSON.stringify(page), /PRIVATE_EXCEPTION_BODY/); assert.equal(page.items[0]!.kind, 'issue');
  }));
});
test('oversized effective values return a typed limit without truncated authorizing data', async () => {
  const f = intentFixture(); f.m.write(join(f.setup.dirs['b'.repeat(40)]!, 'claude/settings.keys.json'), JSON.stringify({ theme: 'x'.repeat(32768) }));
  await f.within(session => Effect.gen(function* () {
    const page = yield* session.inspectIntent(decodeOperationInput('inspectIntent', { section: 'settings' }));
    assert.deepEqual(page.items, []); assert.equal(page.limitReason, 'value-limit'); assert.equal(page.nextCursor, null);
  }));
});
test('intent preview observes a pre-Codex lock without materializing state.json', async () => {
  const f = intentFixture(false, true);
  const legacyPath = join(f.m.paths.claude, '.nortuscc-lock.json'); const legacy = '{"repo":"legacy","files":{"CLAUDE.md":{"hash":"known","appliedAt":"2026-10-14"}}}'; f.m.write(legacyPath, legacy);
  await f.within(session => Effect.gen(function* () {
    const p = yield* session.previewChange(managementOff); assert.equal(p.change.kind, 'machineIntent');
    assert.equal(f.m.read(f.statePath), undefined); assert.equal(f.m.read(f.overridePath), undefined); assert.equal(f.m.read(legacyPath), legacy);
  }));
});
test('a foreign ownership-vector edit between releases is not adopted as fresh routing evidence', async () => {
  const f = intentFixture(true); let edited = false;
  await f.within(session => Effect.gen(function* () {
    const done = yield* f.apply(session, managementOff);
    assert.ok(edited); assert.equal(done.state, 'failed'); assert.equal(done.intentSaved, true); assert.equal(done.parity?.state, 'needsInspection');
    assert.deepEqual(done.parity?.committedKeys, ['intent:overrides', 'intent:routing:claude:CLAUDE.md']); assert.equal(f.m.read(f.codex), 'Codex prose\n' + MCP_ROUTING_BYTES);
  }), { fs: real => ({ ...real, writeTextAtomic: (path, text) => real.writeTextAtomic(path, text).pipe(Effect.tap(() => Effect.sync(() => {
    if (path !== f.claude || edited) return;
    edited = true; const state = JSON.parse(f.m.read(f.statePath)!); state.mcpRouting.files['codex:AGENTS.md'].state = 'released'; f.m.write(f.statePath, JSON.stringify(state));
  }))) }) });
});
test('History checkpoints never contain an owned setting value', async () => {
  const f = intentFixture();
  await f.within(session => Effect.gen(function* () {
    const done = yield* f.apply(session, { kind: 'machineIntent', patch: { kind: 'setting', fileId: 'claude:settings.json', key: 'theme', action: 'set', value: 'PRIVATE_ALLOWED_SETTING_VALUE' } }); assert.equal(done.state, 'succeeded');
  }));
  const history = JSON.stringify(await f.m.events()); assert.doesNotMatch(history, /PRIVATE_ALLOWED_SETTING_VALUE/); assert.match(history, /operation-checkpoint/);
});
test('declaration removal re-resolves source-wide pin policy before accepting a write', async () => {
  const f = intentFixture();
  f.m.write(f.overridePath, JSON.stringify({ version: 2, skillAdditions: [{ source: 'a/b', name: 'personal', targets: ['claude'] }] }));
  f.m.write(join(f.setup.dirs['b'.repeat(40)]!, 'skill-pins.json'), JSON.stringify({ version: 1, pins: { 'a/b': 'a'.repeat(40) } }));
  await f.within(session => Effect.gen(function* () {
    const before = f.m.read(f.overridePath);
    const skills = yield* session.inspectIntent(decodeOperationInput('inspectIntent', { section: 'skills' }));
    assert.equal(skills.items[0]!.kind, 'skill'); assert.equal(skills.items[0]!.kind === 'skill' && skills.items[0].revision, 'a'.repeat(40));
    const failure = yield* Effect.flip(session.previewChange({ kind: 'machineIntent', patch: { kind: 'removeSkillDeclaration', source: 'a/b', name: 'personal' } }));
    assert.equal(failure.code, 'PROFILE_INVALID'); assert.equal(f.m.read(f.overridePath), before);
  }));
});

const unsafePreviewRefusal = (session: AgentSession, change: Parameters<AgentSession['previewChange']>[0]) => Effect.gen(function* () {
  const error = yield* Effect.flip(session.previewChange(change));
  assert.equal(error.code, 'OVERSIZED');
  assert.equal(error.message, 'Intent preview contains unsafe or oversized owner data');
  assert.doesNotMatch(error.message, /sk-/);
  assert.deepEqual((yield* session.runs.list({ limit: 10 })).runs, []);
});

test('intent preview refuses a credential-shaped sibling in source impact before retaining a plan', async () => {
  const f = intentFixture();
  f.m.write(join(f.setup.dirs['b'.repeat(40)]!, 'skills-manifest.txt'), '[a/b]\nsafe\nsk-reviewfixture\n');
  const bytes = f.m.read(f.overridePath);
  await f.within(session => Effect.gen(function* () {
    const read = yield* session.inspectIntent(decodeOperationInput('inspectIntent', { section: 'skills' }));
    assert.equal(read.limitReason, 'identity-limit');
    yield* unsafePreviewRefusal(session, { kind: 'machineIntent', patch: { kind: 'skill', source: 'a/b', name: 'safe', action: 'disable' } });
    assert.equal(f.m.read(f.overridePath), bytes); assert.equal(f.m.read(f.statePath), undefined);
  }));
});

test('intent preview refuses unsafe before provenance using the read safety contract', async () => {
  const f = intentFixture(); f.m.write(f.overridePath, '{"version":2,"settings":{"claude:settings.json":{"theme":"light"}}}');
  const bytes = f.m.read(f.overridePath);
  await f.within(session => Effect.gen(function* () {
    const read = yield* session.inspectIntent(decodeOperationInput('inspectIntent', { section: 'settings' }));
    assert.equal(read.limitReason, 'identity-limit');
    yield* unsafePreviewRefusal(session, { kind: 'machineIntent', patch: { kind: 'setting', fileId: 'claude:settings.json', key: 'theme', action: 'reset' } });
    assert.equal(f.m.read(f.overridePath), bytes); assert.equal(f.m.read(f.statePath), undefined);
  }), { overrides: store => ({ ...store, read: store.read.pipe(Effect.map(input => ({ ...input, source: '/owner/sk-beforefixture/overrides.json' }))) }) });
});

test('intent preview refuses unsafe future provenance before retaining a plan', async () => {
  const f = intentFixture(); const bytes = f.m.read(f.overridePath);
  await f.within(session => Effect.gen(function* () {
    const read = yield* session.inspectIntent(decodeOperationInput('inspectIntent', { section: 'settings' }));
    assert.equal(read.limitReason, undefined);
    yield* unsafePreviewRefusal(session, { kind: 'machineIntent', patch: { kind: 'setting', fileId: 'claude:settings.json', key: 'theme', action: 'set', value: 'light' } });
    assert.equal(f.m.read(f.overridePath), bytes); assert.equal(f.m.read(f.statePath), undefined);
  }), { inspection: value => ({ ...value, paths: { ...value.paths, stateRoot: '/owner/sk-afterfixture' } }) });
});

test('intent preview refuses an unsafe destination independently of before and after provenance', async () => {
  const f = intentFixture(); const bytes = f.m.read(f.overridePath);
  await f.within(session => Effect.gen(function* () {
    const read = yield* session.inspectIntent(decodeOperationInput('inspectIntent', { section: 'configuration' }));
    assert.equal(read.limitReason, undefined);
    yield* unsafePreviewRefusal(session, { kind: 'machineIntent', patch: { kind: 'manageConfig', action: 'reset' } });
    assert.equal(f.m.read(f.overridePath), bytes); assert.equal(f.m.read(f.statePath), undefined);
  }), { paths: paths => ({ ...paths, stateRoot: join(f.m.root, 'sk-destinationfixture') }) });
});

test('intent preview preserves safe selected and sibling identities exactly', async () => {
  const f = intentFixture();
  f.m.write(join(f.setup.dirs['b'.repeat(40)]!, 'skills-manifest.txt'), '[a/b]\nsafe\nordinary-sibling\n');
  const bytes = f.m.read(f.overridePath);
  await f.within(session => Effect.gen(function* () {
    const p = yield* session.previewChange({ kind: 'machineIntent', patch: { kind: 'skill', source: 'a/b', name: 'safe', action: 'disable' } });
    assert.equal(p.change.kind, 'machineIntent');
    assert.ok('machineIntent' in p);
    assert.deepEqual(p.machineIntent.sourceImpact, [{ source: 'a/b', skills: ['safe', 'ordinary-sibling'], policy: 'upstream' }]);
    const change = p.machineIntent.intentChanges[0]!;
    assert.equal(change.before?.kind, 'skill'); assert.equal(change.after?.kind, 'skill');
    if (change.before?.kind === 'skill' && change.after?.kind === 'skill') {
      assert.equal(change.before.source, 'a/b'); assert.equal(change.before.name, 'safe'); assert.equal(change.before.enabled, true);
      assert.equal(change.after.source, 'a/b'); assert.equal(change.after.name, 'safe'); assert.equal(change.after.enabled, false);
    }
    assert.equal(f.m.read(f.overridePath), bytes); assert.equal(f.m.read(f.statePath), undefined);
  }));
});
