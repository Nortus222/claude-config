import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOperationInput } from '../src/operations/index.ts';
test('capture uses the strict shared change contract', () => {
 const input = { scope: { kind: 'machine' }, change: { kind: 'capture', only: [], targets: ['claude'], takeLocal: false, allowShrink: false } };
 assert.deepEqual(decodeOperationInput('previewChange', input), input);
 assert.throws(() => decodeOperationInput('previewChange', { ...input, change: { ...input.change, path: '/tmp/escape' } }));
});

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { configDomain, Fs, FsFailed, StateStore } from '@nortuscc/machine';
import { startAgent, makeSession, type AgentSession } from '../src/index.ts';
import { operationDigest } from '../src/runs.ts';
import { agentMachine } from './support/agent-machine.ts';
import { setupFixture } from './support/setup-fixture.ts';
import type { OperationChange } from '../src/operations/index.ts';
const C = 'config:claude:CLAUDE.md'; const X = 'config:codex:AGENTS.md';
const capture = (only: string[]): OperationChange => ({ kind: 'capture', only, takeLocal: true, allowShrink: false });
const fixture = async () => {
 const m = agentMachine(); const setup = setupFixture(join(m.root, 'snapshot'), { headFiles: { 'claude/CLAUDE.md': '# snapshot Claude\n', 'codex/AGENTS.md': '# snapshot Codex\n' } });
 m.write(join(m.paths.repo, 'claude/CLAUDE.md'), '# author Claude\r\n'); m.write(join(m.paths.repo, 'codex/AGENTS.md'), '# author Codex\n');
 m.write(join(m.paths.repo, 'claude/settings.keys.json'), '{ "theme": "dark" }\n');
 const git = (...args: string[]) => execFileSync('git', ['-C', m.paths.repo, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
 git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
 m.write(join(m.paths.claude, 'CLAUDE.md'), '# PRIVATE local body\n'); m.write(join(m.paths.codex, 'AGENTS.md'), '# second\n');
 await m.trust();
 const within = <A,E>(body: (session: AgentSession) => Effect.Effect<A,E>, failure?: 'second' | 'baseline') => m.run(Effect.scoped(Effect.gen(function* () {
  const fs = yield* Fs; const store = yield* StateStore;
  const fail = new FsFailed({ op: 'private path', path: 'private path', reason: 'PRIVATE failure detail' });
  return yield* Effect.gen(function* () {
   const domains = () => [configDomain]; const handle = yield* startAgent(domains, { deferStart: true });
   const session = yield* makeSession(handle, { signal: new AbortController().signal, domains });
   yield* session.inspect('mcp'); return yield* body(session);
  }).pipe(Effect.provideService(Fs, { ...fs, writeTextAtomic: (path,text) => failure === 'second' && path.endsWith('codex/AGENTS.md') ? Effect.fail(fail) : fs.writeTextAtomic(path,text) }),
   Effect.provideService(StateStore, { ...store, update: f => failure === 'baseline' ? Effect.fail(fail) : store.update(f) }));
 })), setup.source);
 return { m, setup, git, within };
};
const submit = (session: AgentSession, planId: string, requestId: string) => Effect.gen(function* () {
 const request = { planId, requestId, inputDigest: operationDigest(planId), actor: 'mcp' as const };
 const accepted = yield* session.runs.submit(request);
 yield* Effect.callback<void>(resume => { const off = session.runs.subscribe(accepted.runId, run => { if (run.result) resume(Effect.void); }); return Effect.sync(off); });
 while (yield* session.running) yield* Effect.yieldNow;
 return { run: yield* session.runs.get(accepted.runId), request };
});
const treeBytes = (root: string): Record<string,string> => Object.fromEntries(readdirSync(root).sort().flatMap(name => {
 const path = join(root, name);
 return statSync(path).isDirectory() ? Object.entries(treeBytes(path)).map(([child,bytes]) => [name + '/' + child, bytes]) : [[name, readFileSync(path).toString('hex')]];
}));
test('durable capture selects the configured author, preserves snapshot/index/unrelated bytes, and redacts private bodies', async () => {
 const f = await fixture();
 const snapshot = treeBytes(join(f.m.root, 'snapshot'));
 f.m.write(join(f.m.paths.repo, 'unrelated'), 'staged unrelated\0bytes'); f.git('add', 'unrelated');
 f.m.write(join(f.m.paths.repo, 'unrelated'), 'dirty unrelated\0bytes'); f.m.write(join(f.m.paths.repo, 'untracked'), 'untracked');
 const index = readFileSync(join(f.m.paths.repo, '.git/index'));
 await f.within(session => Effect.gen(function* () {
  const preview = yield* session.previewChange(capture([C])); assert.equal(preview.change.kind, 'capture');
  assert.ok('capture' in preview); if (!('capture' in preview)) return;
  assert.equal(preview.capture.checkout, f.m.paths.repo); assert.equal(preview.capture.redacted, true); assert.equal(preview.capture.documents.length, 1);
  assert.doesNotMatch(JSON.stringify(preview), /PRIVATE|snapshot Claude|author Claude/);
  const { run, request } = yield* submit(session, preview.planId, 'capture'); assert.equal(run.state, 'succeeded'); assert.deepEqual(run.parity?.committedKeys, [C]);
  assert.equal((yield* session.runs.submit(request)).runId, run.runId);
 }));
 assert.equal(f.m.read(join(f.m.paths.repo, 'claude/CLAUDE.md')), '# PRIVATE local body\n');
 assert.deepEqual(treeBytes(join(f.m.root, 'snapshot')), snapshot);
 assert.equal(f.m.read(join(f.m.paths.repo, 'unrelated')), 'dirty unrelated\0bytes'); assert.equal(f.m.read(join(f.m.paths.repo, 'untracked')), 'untracked');
 assert.deepEqual(readFileSync(join(f.m.paths.repo, '.git/index')), index);
 assert.doesNotMatch(JSON.stringify(await f.m.events()), /PRIVATE|snapshot Claude|author Claude/);
});
test('selected dirty bytes or index mode changes invalidate a retained capture before acceptance', async () => {
 for (const changed of ['bytes', 'index']) {
  const f = await fixture();
  await f.within(session => Effect.gen(function* () {
   const p = yield* session.previewChange(capture([C]));
   if (changed === 'bytes') f.m.write(join(f.m.paths.repo, 'claude/CLAUDE.md'), '# external'); else f.git('update-index', '--chmod=+x', 'claude/CLAUDE.md');
   const error = yield* Effect.flip(session.runs.submit({ planId: p.planId, requestId: 'stale', inputDigest: operationDigest(p.planId), actor: 'mcp' }));
   assert.equal(error.code, 'UNKNOWN_PLAN'); assert.notEqual(f.m.read(join(f.m.paths.repo, 'claude/CLAUDE.md')), '# PRIVATE local body\n');
  }));
 }
});
test('partial capture and baseline-write failure survive restart without replay or private exception leakage', async () => {
 for (const failure of ['second', 'baseline'] as const) {
  const f = await fixture();
  const { run, request } = await f.within(session => Effect.gen(function* () {
   const p = yield* session.previewChange(capture(failure === 'baseline' ? [C] : [C,X]));
   return yield* submit(session, p.planId, failure);
  }), failure);
  assert.equal(run.state, 'failed'); assert.equal(run.parity?.state, 'needsInspection'); assert.deepEqual(run.parity?.committedKeys, [C]); assert.equal(run.parity?.backupIds.length, 1);
  assert.equal(f.m.read(join(f.m.paths.repo, 'claude/CLAUDE.md')), '# PRIVATE local body\n');
  const backup = join(f.m.paths.backups, run.parity!.backupIds[0]!, 'claude/CLAUDE.md.repo'); assert.equal(f.m.read(backup), '# author Claude\r\n');
  await f.within(session => Effect.gen(function* () {
   const recovered = yield* session.runs.get(run.runId); assert.deepEqual(recovered.parity, run.parity);
   assert.equal((yield* session.runs.submit(request)).runId, run.runId);
  }));
  assert.doesNotMatch(JSON.stringify([run, await f.m.events()]), /PRIVATE|private path/);
 }
});
