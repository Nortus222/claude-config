import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { acquireApplyLock, backupsForRun, Fs, FsFailed, hashText, machinePaths, nodeFs, stateStore, StateStore, validMcpRouting } from '../src/index.ts';
import { inspectMcpRouting, setMcpRouting, MCP_ROUTING_BYTES } from '../src/config/mcp-routing.ts';
import { configMachine } from './config-machine.ts';

const id = 'claude:CLAUDE.md' as const;
const key = `config:${id}`;
const local = (m: ReturnType<typeof configMachine>) => join(m.paths.claude, 'CLAUDE.md');
const routing = async (m: ReturnType<typeof configMachine>, active: boolean, overrides?: Parameters<typeof m.desired>[0]) => {
  const desired = await m.desired(overrides);
  const before = await Effect.runPromise(inspectMcpRouting(desired, id).pipe(Effect.provide(m.layer())));
  return Effect.runPromise(setMcpRouting(desired, id, active, before.evidence).pipe(Effect.provide(m.layer())));
};
const ownership = (m: ReturnType<typeof configMachine>) => JSON.parse(m.read(join(m.paths.stateRoot, 'state.json'))!).mcpRouting;

test('connect owns exact bytes, portable baseline survives apply/capture, and disconnect preserves prose and EOL', async () => {
  const m = configMachine();
  await m.sync();
  assert.equal((await routing(m, true)).outcome, 'changed');
  assert.equal(m.state().files[id]!.hash, hashText('# repo claude\n'));
  assert.equal((await m.report()).items.find(i => i.key === key)!.state, 'clean');
  m.write(local(m), `# edited\r\n${MCP_ROUTING_BYTES}trailing prose\r\n`);
  await m.sync('capture');
  assert.equal(m.read(join(m.paths.repo, 'claude/CLAUDE.md')), '# edited\r\ntrailing prose\r\n');
  assert.equal((await routing(m, false)).outcome, 'changed');
  assert.equal(m.read(local(m)), '# edited\r\ntrailing prose\r\n');
  assert.equal(ownership(m).files[id].state, 'released');
});

for (const force of [false, true]) test(`apply preserves active guidance with force=${force}`, async () => {
  const m = configMachine(); await m.sync(); await routing(m, true);
  m.write(join(m.paths.repo, 'claude/CLAUDE.md'), '# next\n');
  if (force) m.write(local(m), `# local\n${MCP_ROUTING_BYTES}`);
  await m.sync('apply', { force });
  assert.equal(m.read(local(m)), `# next\n${MCP_ROUTING_BYTES}`);
  assert.equal(m.state().files[id]!.hash, hashText('# next\n'));
});

for (const damage of ['edited', 'duplicate', 'foreign', 'invalid'] as const) {
  test(`${damage} ownership refuses apply, capture, uninstall and disconnect even forced`, async () => {
    const m = configMachine(); await m.sync(); await routing(m, true);
    if (damage === 'edited') m.write(local(m), m.read(local(m))!.replace('For nortuscc', 'Changed nortuscc'));
    if (damage === 'duplicate') m.write(local(m), m.read(local(m))! + MCP_ROUTING_BYTES);
    if (damage === 'foreign' || damage === 'invalid') {
      const path = join(m.paths.stateRoot, 'state.json'); const state = JSON.parse(m.read(path)!);
      if (damage === 'foreign') delete state.mcpRouting;
      else state.mcpRouting.files[id].bytes = 'untrusted';
      m.write(path, JSON.stringify(state));
    }
    const before = m.read(local(m)); const repo = m.read(join(m.paths.repo, 'claude/CLAUDE.md'));
    for (const kind of ['apply', 'capture', 'uninstall'] as const) {
      const result = await m.sync(kind, { force: true });
      assert.match(result.plan.skipped.find(i => i.key === key)!.reason, /routing/i);
      assert.equal(m.read(local(m)), before); assert.equal(m.read(join(m.paths.repo, 'claude/CLAUDE.md')), repo);
    }
    assert.equal((await routing(m, false)).outcome, 'conflict');
    assert.equal(m.read(local(m)), before);
  });
}

test('management off offers text and disconnect still removes exact owned span', async () => {
  const m = configMachine(); await m.sync(); await routing(m, true);
  const off = { source: 'overrides.json', value: { manageConfig: false }, issues: [] };
  assert.equal((await routing(m, true, off)).outcome, 'unmanaged');
  m.write(local(m), `mine\r\n${MCP_ROUTING_BYTES}tail`);
  assert.equal((await routing(m, false, off)).outcome, 'changed');
  assert.equal(m.read(local(m)), 'mine\r\ntail');
});

test('missing active block is explicit repair-needed; ordinary apply does not invent it', async () => {
  const m = configMachine(); await m.sync(); await routing(m, true);
  m.write(local(m), '# repo claude\n');
  const desired = await m.desired();
  const status = await Effect.runPromise(inspectMcpRouting(desired, id).pipe(Effect.provide(m.layer())));
  assert.equal(status.status, 'missing');
  await m.sync(); assert.equal(m.read(local(m)), '# repo claude\n');
  assert.equal((await routing(m, true)).outcome, 'changed');
  assert.equal(m.read(local(m)), '# repo claude\n' + MCP_ROUTING_BYTES);
});

for (const kind of ['apply', 'capture', 'uninstall'] as const) test(`${kind} refuses stale exact bytes even when coarse state stays unchanged`, async () => {
  const m = configMachine(); await m.sync(); await routing(m, true);
  m.write(local(m), '# local one\n' + MCP_ROUTING_BYTES);
  const report = await m.report(); const plan = m.plan(report, kind, { force: true });
  m.write(local(m), '# local two\n' + MCP_ROUTING_BYTES);
  const events = await m.execute(plan, report);
  const result = events.find(e => e.type === 'finished' && e.key === key);
  assert.equal(result?.type === 'finished' ? result.outcome : undefined, 'failed');
  assert.equal(m.read(local(m)), '# local two\n' + MCP_ROUTING_BYTES);
});

test('routing refuses stale evidence, respects the shared lock and maintenance fence', async () => {
  const m = configMachine(); await m.sync(); const desired = await m.desired();
  const status = await Effect.runPromise(inspectMcpRouting(desired, id).pipe(Effect.provide(m.layer())));
  m.write(local(m), '# user changed\n');
  assert.equal((await Effect.runPromise(setMcpRouting(desired, id, true, status.evidence).pipe(Effect.provide(m.layer())))).outcome, 'conflict');
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* acquireApplyLock;
    const current = yield* inspectMcpRouting(desired, id);
    const blocked = yield* Effect.exit(setMcpRouting(desired, id, true, current.evidence));
    assert.equal(blocked._tag, 'Failure');
    assert.equal((yield* setMcpRouting(desired, id, true, current.evidence, { lockHeld: true })).outcome, 'changed');
  })).pipe(Effect.provide(m.layer())));
  m.write(join(m.paths.stateRoot, 'agent/pending-update.json'), '{}');
  await assert.rejects(routing(m, false), /maintenance/i);
});

test('released receipt survives StateStore writes and strips original routing during uninstall', async () => {
  const m = configMachine(); await m.sync(); await routing(m, true); await routing(m, false);
  const original = join(m.paths.backups, 'nortuscc-2026-10-06T00-00-00-000Z', 'claude', 'CLAUDE.md');
  m.write(original, 'original\r\n' + MCP_ROUTING_BYTES + 'tail\r\n');
  await Effect.runPromise(Effect.flatMap(StateStore, store => store.update(s => ({ ...s, repo: m.paths.repo }))).pipe(Effect.provide(m.layer())));
  await m.sync('uninstall');
  assert.equal(m.read(local(m)), 'original\r\ntail\r\n');
  assert.equal(ownership(m).files[id].state, 'released');
});

test('uninstall retires live routing and leaves no active receipt', async () => {
  const m = configMachine(); m.write(local(m), 'original\r\n');
  await m.sync(); await routing(m, true); await m.sync('uninstall');
  assert.equal(m.read(local(m)), 'original\r\n');
  assert.equal(ownership(m).files[id].state, 'released');
});

test('malformed optional ownership is retained and fails closed without marker bytes', async () => {
  const m = configMachine(); await m.sync();
  const path = join(m.paths.stateRoot, 'state.json'); const state = JSON.parse(m.read(path)!);
  state.mcpRouting = { invalid: true }; m.write(path, JSON.stringify(state));
  await Effect.runPromise(Effect.flatMap(StateStore, store => store.update(s => ({ ...s, repo: m.paths.repo }))).pipe(Effect.provide(m.layer())));
  assert.deepEqual(ownership(m), { invalid: true });
  assert.equal(validMcpRouting(ownership(m)), false);
  assert.equal((await m.report()).items.find(i => i.key === key)!.state, 'routing-conflict');
});

test('disconnect releases valid intent on an edited block without claiming physical cleanup', async () => {
  const m = configMachine(); await m.sync(); await routing(m, true);
  const edited = m.read(local(m))!.replace('For nortuscc', 'Edited nortuscc');
  m.write(local(m), edited);
  const outcome = await routing(m, false);
  assert.deepEqual([outcome.outcome, outcome.intent, outcome.blockStatus, outcome.intentChanged, outcome.instructionsChanged],
    ['conflict', 'released', 'conflict', true, false]);
  assert.equal(m.read(local(m)), edited);
  assert.equal(ownership(m).files[id].state, 'released');
  const unmanaged = await m.report({ source: 'overrides.json', issues: [], value: { manageConfig: false } });
  assert.equal(unmanaged.items.find(i => i.key === key)!.disposition, 'blocked');
  assert.equal((await m.sync('apply', { force: true })).plan.steps.some(s => s.key === key), false);
  m.write(local(m), '# repo claude\n' + MCP_ROUTING_BYTES);
  await m.sync();
  assert.equal(m.read(local(m)), '# repo claude\n');
  m.write(join(m.paths.backups, 'nortuscc-2026-10-06T00-00-00-000Z', 'claude', 'CLAUDE.md'), 'old\r\n' + MCP_ROUTING_BYTES);
  await m.sync('uninstall');
  assert.equal(m.read(local(m)), 'old\r\n');
});

test('a released receipt alone never causes repeated uninstall writes', async () => {
  const m = configMachine(); await m.sync(); await routing(m, true); await m.sync('uninstall');
  assert.equal((await m.sync('uninstall')).plan.steps.length, 0);
});

test('routing-only ownership removes its span on uninstall without deleting the unmanaged body', async () => {
  const m = configMachine(); m.write(local(m), 'existing\r\n');
  await routing(m, true); await m.sync('uninstall');
  assert.equal(m.read(local(m)), 'existing\r\n');
});

test('a repo routing marker is foreign, never silently stripped or copied', async () => {
  const m = configMachine(); await m.sync();
  m.write(join(m.paths.repo, 'claude/CLAUDE.md'), '# public\n' + MCP_ROUTING_BYTES);
  assert.match((await m.sync('apply', { force: true })).plan.skipped.find(s => s.key === key)!.reason, /foreign MCP routing/);
  assert.equal(m.read(local(m)), '# repo claude\n');
});

const faultLayer = (m: ReturnType<typeof configMachine>, patch: (fs: Fs['Service']) => Fs['Service']) => {
  const fs = Layer.effect(Fs, Effect.map(Fs, patch)).pipe(Layer.provide(nodeFs));
  return Layer.mergeAll(stateStore, backupsForRun(new Date('2026-10-08T12:00:00Z')))
    .pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(m.paths), fs)));
};

for (const active of [true, false]) test(`interrupted ${active ? 'connect' : 'disconnect'} retains backed-up, recoverable ownership before file write`, async () => {
  const m = configMachine(); await m.sync();
  if (!active) await routing(m, true);
  const desired = await m.desired();
  const before = m.read(local(m));
  const beforeState = m.read(join(m.paths.stateRoot, 'state.json'));
  const status = await Effect.runPromise(inspectMcpRouting(desired, id).pipe(Effect.provide(m.layer())));
  const layer = faultLayer(m, fs => ({ ...fs, writeTextAtomic: (path, text) => path === local(m)
    ? Effect.fail(new FsFailed({ op: 'write', path, reason: 'injected failure' })) : fs.writeTextAtomic(path, text) }));
  await assert.rejects(Effect.runPromise(setMcpRouting(desired, id, active, status.evidence).pipe(Effect.provide(layer))), /injected failure/);
  assert.equal(m.read(local(m)), before);
  assert.equal(ownership(m).files[id].state, active ? 'active' : 'released');
  const backup = join(m.paths.backups, 'nortuscc-2026-10-08T12-00-00-000Z');
  assert.equal(m.read(join(backup, 'mcp-routing/claude/CLAUDE.md')), before);
  assert.equal(m.read(join(backup, 'state.json')), beforeState);
  const repair = await Effect.runPromise(inspectMcpRouting(desired, id).pipe(Effect.provide(m.layer())));
  assert.equal(repair.status, active ? 'missing' : 'released');
  assert.equal((await routing(m, active)).outcome, 'changed');
  assert.equal(m.read(local(m)), active ? before + MCP_ROUTING_BYTES : '# repo claude\n');
});

test('an edit during backup is detected before ownership or live instructions change', async () => {
  const m = configMachine(); await m.sync(); const desired = await m.desired();
  const status = await Effect.runPromise(inspectMcpRouting(desired, id).pipe(Effect.provide(m.layer())));
  const layer = faultLayer(m, fs => ({ ...fs, copy: (from, to, options) => Effect.gen(function* () {
    yield* fs.copy(from, to, options);
    if (from === join(m.paths.stateRoot, 'state.json')) yield* fs.writeTextAtomic(local(m), 'concurrent edit\r\n');
  }) }));
  const result = await Effect.runPromise(setMcpRouting(desired, id, true, status.evidence).pipe(Effect.provide(layer)));
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.intentChanged, false);
  assert.equal(m.read(local(m)), 'concurrent edit\r\n');
  assert.equal(ownership(m), undefined);
});

test('an edit during ownership persistence is detected before the live write and reports partial intent', async () => {
  const m = configMachine(); await m.sync(); const desired = await m.desired();
  const status = await Effect.runPromise(inspectMcpRouting(desired, id).pipe(Effect.provide(m.layer())));
  const layer = faultLayer(m, fs => ({ ...fs, writeTextAtomic: (path, text) => Effect.gen(function* () {
    yield* fs.writeTextAtomic(path, text);
    if (path === join(m.paths.stateRoot, 'state.json')) yield* fs.writeTextAtomic(local(m), 'concurrent edit\r\n');
  }) }));
  const result = await Effect.runPromise(setMcpRouting(desired, id, true, status.evidence).pipe(Effect.provide(layer)));
  assert.deepEqual([result.outcome, result.intentChanged, result.instructionsChanged], ['conflict', true, false]);
  assert.equal(m.read(local(m)), 'concurrent edit\r\n');
  assert.equal(ownership(m).files[id].state, 'active');
});

test('forced capture publishes only the body and preserves a whole live-file backup', async () => {
  const m = configMachine(); await m.sync(); await routing(m, true);
  m.write(join(m.paths.repo, 'claude/CLAUDE.md'), '# repo moved\n');
  m.write(local(m), '# local moved\r\n' + MCP_ROUTING_BYTES);
  const result = await m.sync('capture', { force: true });
  assert.equal(m.read(join(m.paths.repo, 'claude/CLAUDE.md')), '# local moved\r\n');
  const done = result.events.find(e => e.type === 'done');
  assert.ok(done?.type === 'done' && done.backups);
  assert.equal(m.read(join(done.backups, 'claude/capture/CLAUDE.md')), '# local moved\r\n' + MCP_ROUTING_BYTES);
});

test('CRLF-only edits remain visible to exact evidence despite normalized portable hashes', async () => {
  const m = configMachine(); await m.sync(); await routing(m, true);
  m.write(join(m.paths.repo, 'claude/CLAUDE.md'), '# next\n');
  const report = await m.report(); const plan = m.plan(report);
  m.write(local(m), '# repo claude\r\n' + MCP_ROUTING_BYTES);
  const events = await m.execute(plan, report);
  assert.ok(events.some(e => e.type === 'finished' && e.key === key && e.outcome === 'failed'));
  assert.equal(m.read(local(m)), '# repo claude\r\n' + MCP_ROUTING_BYTES);
});

test('Codex uses only its declared instructions, without touching OpenRouter config or the other receipt', async () => {
  const m = configMachine(); await m.sync(); await routing(m, true);
  const desired = await m.desired(); const codex = 'codex:AGENTS.md' as const;
  const status = await Effect.runPromise(inspectMcpRouting(desired, codex).pipe(Effect.provide(m.layer())));
  const result = await Effect.runPromise(setMcpRouting(desired, codex, true, status.evidence).pipe(Effect.provide(m.layer())));
  assert.equal(result.status, 'installed');
  assert.equal(m.read(join(m.paths.codex, 'AGENTS.md')), '# repo codex\n' + MCP_ROUTING_BYTES);
  assert.equal(m.read(join(m.paths.codexOpenRouter, 'config.toml')), 'model = "glm"\n');
  assert.equal(ownership(m).files[id].state, 'active');
});

test('an original with foreign routing is refused even without a current receipt', async () => {
  const m = configMachine(); await m.sync();
  m.write(join(m.paths.backups, 'nortuscc-2026-10-06T00-00-00-000Z', 'claude', 'CLAUDE.md'), 'original\n' + MCP_ROUTING_BYTES);
  const result = await m.sync('uninstall', { force: true });
  assert.match(result.notes[key]!, /^failed: .*routing conflict/);
  assert.equal(m.read(local(m)), '# repo claude\n');
});

test('unmanaged offered text is portable prose without ownership markers', async () => {
  const m = configMachine();
  const result = await routing(m, true, { source: 'overrides.json', issues: [], value: { manageConfig: false } });
  assert.equal(result.outcome, 'unmanaged');
  assert.ok(result.offeredText.includes('For nortuscc'));
  assert.ok(!result.offeredText.includes('<!--'));
  assert.equal(m.read(local(m)), undefined);
});


test('uninstall with routing restores an original symlink when its target contains no routing', async () => {
  const m = configMachine();
  const target = join(m.paths.claude, 'original.md'); m.write(target, 'original\r\n');
  symlinkSync('original.md', local(m));
  await m.sync(); await routing(m, true); await m.sync('uninstall');
  assert.ok(lstatSync(local(m)).isSymbolicLink());
  assert.equal(readlinkSync(local(m)), 'original.md');
  assert.equal(m.read(local(m)), 'original\r\n');
});

test('restoration refuses a link target containing released routing instead of resurrecting it', async () => {
  const m = configMachine(); const target = join(m.paths.claude, 'original.md');
  m.write(target, 'original\r\n'); symlinkSync('original.md', local(m));
  await m.sync(); await routing(m, true); await routing(m, false);
  m.write(target, 'original\r\n' + MCP_ROUTING_BYTES);
  const result = await m.sync('uninstall', { force: true });
  assert.match(result.notes[key]!, /^failed: Original backup is a link containing routing/);
  assert.equal(m.read(local(m)), '# repo claude\n');
  assert.equal(m.read(target), 'original\r\n' + MCP_ROUTING_BYTES);
});
