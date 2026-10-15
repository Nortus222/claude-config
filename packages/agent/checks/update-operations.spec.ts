import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOperationInput, operationDefinitions } from '../src/operations/index.ts';

test('updates have a dedicated bounded read and explicit author authority', () => {
  assert.ok('inspectUpdates' in operationDefinitions);
  assert.deepEqual(decodeOperationInput('previewChange', { change: { kind: 'update', only: ['skill:one'], authorManifest: false } }).change,
    { kind: 'update', only: ['skill:one'], authorManifest: false });
  assert.throws(() => decodeOperationInput('previewChange', { change: { kind: 'update', only: ['skill:one'] } }));
});

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { Fs, FsFailed, Processes, skillsDomain, OverridesStore, type Command } from '@nortuscc/machine';
import { startAgent, makeSession, type AgentSession } from '../src/index.ts';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import { SetupSource } from '../src/index.ts';
import { agentSkillInstaller } from '../src/skill-installer.ts';
import { operationDigest } from '../src/runs.ts';
import { agentMachine } from './support/agent-machine.ts';
import { setupFixture } from './support/setup-fixture.ts';
const H = 'b'.repeat(40); const OLD = 'a'.repeat(40);
const fixture = async (options: { additions?: boolean; exact?: boolean; author?: boolean; fail?: 'before' | 'after' | 'author' | 'lock'; mapping?: boolean; retained?: boolean; missingNative?: boolean } = {}) => {
 const m = agentMachine();
 const manifest = `[owner/repo]${options.exact ? ' exact' : ''}\none\ngone\n`;
 const setup = setupFixture(join(m.root,'snapshot'),{ headFiles: { 'skills-manifest.txt': manifest } });
 m.write(join(setup.dirs['a'.repeat(40)]!,'skills-manifest.txt'),manifest);
 m.write(join(m.paths.repo,'skills-manifest.txt'),manifest);
 execFileSync('git',['-C',m.paths.repo,'add','.']); execFileSync('git',['-C',m.paths.repo,'-c','user.name=Fixture','-c','user.email=f@f','commit','-qm','fixture']);
 m.write(join(m.paths.repo,'skills-manifest.txt'),manifest + '# dirty author bytes\n');
 const lockPath = join(dirname(m.paths.agentsSkills),'.skill-lock.json');
 const lock: { skills: Record<string, any> } = { skills: {} };
 const entry = (name: string) => ({ source: 'owner/repo', sourceUrl: 'https://github.com/owner/repo.git', skillPath: `s/${name}/SKILL.md`, skillFolderHash: OLD });
 for (const name of ['one','gone']) { lock.skills[name] = entry(name); m.write(join(m.paths.agentsSkills,name,'SKILL.md'),`# ${name}\n`); m.write(join(m.paths.claude,'skills',name,'SKILL.md'),`# old ${name}\n`); }
 if (options.additions) m.write(join(m.paths.stateRoot,'overrides.json'),JSON.stringify({ version: 2, skillAdditions: [{ source: 'owner/repo', name: 'one', targets: ['claude'] }] }));
 if (options.additions) { lock.skills['One'] = lock.skills.one; delete lock.skills.one; if (options.missingNative) delete lock.skills['One']; }
 m.write(lockPath,JSON.stringify(lock)); await m.trust(); const calls: Command[] = [];
 const compose = <T extends { repo: string }>(snapshot: T) => Effect.gen(function* () { const overrides = yield* Effect.promise(() => m.run(OverridesStore.use(store => store.read))); return { ...snapshot, desired: yield* loadProfile(snapshot.repo,{ overrides }).pipe(Effect.provide(nodeFiles)) }; });
 const source = Layer.succeed(SetupSource,{ ...setup.service,current: setup.service.current.pipe(Effect.flatMap(compose),Effect.orDie), load: revision => setup.service.load(revision).pipe(Effect.flatMap(compose),Effect.orDie), effective: decisions => setup.service.effective(decisions).pipe(Effect.flatMap(value => Effect.gen(function* () { return { ...value, applied: yield* compose(value.applied), effective: yield* compose(value.effective) }; })),Effect.orDie) });
 const within = <A,E>(body: (s: AgentSession) => Effect.Effect<A,E>) => m.run(Effect.scoped(Effect.gen(function* () {
  const fs = yield* Fs; const processes = yield* Processes;
  const fake: Processes['Service'] = { ...processes, run: command => {
   if (command.cmd === 'git' && command.args[0] === 'clone') return Effect.succeed({ code: 0, stdout: '', stderr: '' });
   if (command.cmd === 'git' && command.args[0] === 'ls-tree') return Effect.succeed({ code: 0, stdout: ['one','two','three'].map(n => `040000 tree ${H}\ts/${n}\0` + `100644 blob ${H}\ts/${n}/SKILL.md\0`).join(''), stderr: '' });
   if (command.cmd !== 'npx') return processes.run(command);
   calls.push(command);
   return Effect.sync(() => {
    const verb = command.args[2];
    if (options.fail === 'before') return { code: 1, stdout: '', stderr: 'PRIVATE_NATIVE' };
    const start = verb === 'add' ? command.args.indexOf('--skill') + 1 : 3;
    const names = command.args.slice(start).filter((_,i,a) => a.slice(0,i+1).every(v => !v.startsWith('--')));
    for (const name of names) {
     if (verb === 'remove') { if (!options.retained) rmSync(join(m.paths.agentsSkills,name),{ recursive: true, force: true }); rmSync(join(m.paths.claude,'skills',name),{ recursive: true, force: true }); if (!options.retained) delete lock.skills[name]; }
     else { lock.skills[name] = { ...entry(name), skillFolderHash: H }; m.write(join(m.paths.agentsSkills,name,'SKILL.md'),`# new ${name}`); m.write(join(m.paths.claude,'skills',name,'SKILL.md'),`# new ${name}`); }
    }
    m.write(lockPath,JSON.stringify(lock));
    return { code: options.fail === 'after' ? 1 : 0, stdout: '', stderr: 'PRIVATE_NATIVE' };
   });
  } };
  return yield* Effect.gen(function* () {
   const domains = () => [skillsDomain]; const handle = yield* startAgent(domains,{ deferStart: true }); const session = yield* makeSession(handle,{ signal: new AbortController().signal,domains });
   yield* session.inspect('mcp'); return yield* body(session);
  }).pipe(Effect.provideService(Processes,fake), Effect.provideService(Fs,{ ...fs,
   readBytes: path => options.fail === 'lock' && path === lockPath ? Effect.fail(new FsFailed({ op: 'read', path, reason: 'PRIVATE_READ' })) : fs.readBytes(path),
   writeTextAtomic: (path,text) => options.fail === 'author' && path.endsWith('/checkout/skills-manifest.txt') ? Effect.fail(new FsFailed({ op: 'write', path, reason: 'PRIVATE_AUTHOR' })) : fs.writeTextAtomic(path,text),
  }),Effect.provide(options.mapping === false ? agentSkillInstaller() : agentSkillInstaller({ home: dirname(m.paths.claude) })));
 })),source);
 return { m,setup,within,calls,lockPath };
};
const update = (only: string[],authorManifest = false) => ({ kind: 'update' as const, only, targets: ['claude'] as const, authorManifest });
const submit = (session: AgentSession,planId: string,requestId = 'update') => Effect.gen(function* () {
 const request = { planId, requestId, inputDigest: operationDigest(planId),actor: 'mcp' as const }; const accepted = yield* session.runs.submit(request);
 yield* Effect.callback<void>(resume => { const off = session.runs.subscribe(accepted.runId,run => { if (run.result) resume(Effect.void); }); return Effect.sync(off); });
 while (yield* session.running) yield* Effect.yieldNow;
 const run = yield* session.runs.get(accepted.runId); assert.equal((yield* session.runs.submit(request)).runId,run.runId); return run;
});

test('bounded updates execute a source-qualified offer read, paginate and reject stale cursors', async () => {
 const f = await fixture(); await f.within(s => Effect.gen(function* () {
  const first = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{ limit: 1 })); assert.equal(first.items.length,1); assert.ok(first.nextCursor);
  const all = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{ limit: 100 })); assert.equal(all.items.find(i => i.name === 'two')?.offered?.digest,H); assert.equal(all.items.find(i => i.name === 'gone')?.state,'gone');
  assert.ok(all.items.every(i => i.id === `skill:${i.source}/${i.name}`));
  const next = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{ limit: 1,cursor: first.nextCursor! })); assert.notEqual(first.items[0]?.id,next.items[0]?.id);
  f.m.write(f.lockPath,'{"skills":{}}'); assert.equal((yield* Effect.flip(s.inspectUpdates(decodeOperationInput('inspectUpdates',{ limit: 1,cursor: first.nextCursor! })))).code,'UNKNOWN_PLAN');
 }));
});

test('machine-only selected updates, adoption and scoped prune preserve snapshot and dirty author bytes', async () => {
 const f = await fixture(); const author = f.m.read(join(f.m.paths.repo,'skills-manifest.txt')); const snapshot = f.m.read(join(f.setup.dirs['b'.repeat(40)]!,'skills-manifest.txt'));
 await f.within(s => Effect.gen(function* () {
  const p = yield* s.previewChange(update(['skill:one','skill:gone','skill:two'])); assert.ok(!p.plan.steps.some(step => step.key === 'skills:manifest')); assert.ok(p.plan.skipped.some(i => i.key === 'skill:three'));
  const run = yield* submit(s,p.planId); assert.equal(run.state,'succeeded'); assert.ok(run.parity?.backupIds.length); assert.ok(run.parity?.committedKeys.includes('skills:remove'));
 }));
 assert.equal(f.m.read(join(f.m.paths.repo,'skills-manifest.txt')),author); assert.equal(f.m.read(join(f.setup.dirs['b'.repeat(40)]!,'skills-manifest.txt')),snapshot);
 assert.equal(existsSync(join(f.m.paths.agentsSkills,'three')),false); assert.equal(existsSync(join(f.m.paths.agentsSkills,'gone')),false);
 assert.ok(f.calls.every(c => c.args.includes('--agent') && c.env?.CLAUDE_CONFIG_DIR === f.m.paths.claude && c.env?.CODEX_HOME === f.m.paths.codex)); assert.ok(f.calls.every(c => c.args[2] !== 'update'));
 const folder = readdirSync(f.m.paths.backups)[0]!; assert.match(f.m.read(join(f.m.paths.backups,folder,'skill-lock.json'))!,/gone/); assert.equal(f.m.read(join(f.m.paths.backups,folder,'claude/skills/one/SKILL.md')),'# old one\n');
});

test('explicit author update backs up dirty bytes and writes only the reviewed result', async () => {
 const f = await fixture(); const before = f.m.read(join(f.m.paths.repo,'skills-manifest.txt'));
 await f.within(s => Effect.gen(function* () {
  const p = yield* s.previewChange(update(['skill:gone','skill:two'],true)); assert.ok('authorManifest' in p && p.authorManifest?.documents.length === 1); assert.doesNotMatch(JSON.stringify(p),/dirty author bytes/);
  const run = yield* submit(s,p.planId); assert.equal(run.state,'succeeded'); assert.ok(run.parity?.committedKeys.includes('skills:manifest'));
 }));
 assert.match(f.m.read(join(f.m.paths.repo,'skills-manifest.txt'))!,/one\ntwo/); assert.doesNotMatch(f.m.read(join(f.m.paths.repo,'skills-manifest.txt'))!,/gone/);
 const folder = readdirSync(f.m.paths.backups)[0]!; assert.equal(f.m.read(join(f.m.paths.backups,folder,'author/skills-manifest.txt')),before);
});

test('partial installer outcomes refuse changed author proposals and retain machine and recovery facts', async () => {
 for (const failure of ['before','after','author'] as const) {
  const f = await fixture({ fail: failure }); const before = f.m.read(join(f.m.paths.repo,'skills-manifest.txt')); let runId = ''; let committed: readonly string[] = [];
  await f.within(s => Effect.gen(function* () {
   const p = yield* s.previewChange(update(['skill:two'],true)); const run = yield* submit(s,p.planId,failure); runId = run.runId; committed = run.parity?.committedKeys ?? []; assert.equal(run.state,'failed',failure); assert.ok(run.parity?.backupIds.length);
   assert.doesNotMatch(JSON.stringify(run),/PRIVATE/);
   if (failure === 'before') assert.ok(!run.parity?.committedKeys.includes('skills:manifest'));
   if (failure === 'after') assert.ok(run.parity?.committedKeys.includes('skills:manifest'));
  }));
  if (failure !== 'after') assert.equal(f.m.read(join(f.m.paths.repo,'skills-manifest.txt')),before);
  const callCount = f.calls.length; await f.within(s => Effect.gen(function* () { const recovered = yield* s.runs.get(runId); assert.equal(recovered.state,'failed'); assert.deepEqual(recovered.parity?.committedKeys,committed); assert.equal(f.calls.length,callCount); }));
 }
});

test('author bytes, holds and native lock changes invalidate previews; unreadable lock never becomes absence', async () => {
 for (const changed of ['author','lock','holds'] as const) {
  const f = await fixture(); await f.within(s => Effect.gen(function* () {
   const p = yield* s.previewChange(update(['skill:two'],true)); f.m.write(changed === 'author' ? join(f.m.paths.repo,'skills-manifest.txt') : changed === 'lock' ? f.lockPath : join(f.m.paths.stateRoot,'sync.json'),'{}');
   assert.equal((yield* Effect.flip(s.runs.submit({ planId: p.planId,requestId: changed,inputDigest: operationDigest(p.planId),actor:'mcp' }))).code,'UNKNOWN_PLAN'); assert.equal(f.calls.length,0);
  }));
 }
 const f = await fixture({ fail: 'lock' }); await f.within(s => Effect.gen(function* () { const read = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{})); assert.equal(read.unavailable,true); yield* Effect.flip(s.previewChange(update(['skill:one']))); assert.equal(f.calls.length,0); }));
});

test('unsupported native mapping refuses before effects; author false needs no usable author checkout', async () => {
 const blocked = await fixture({ mapping: false }); await blocked.within(s => Effect.gen(function* () { yield* Effect.flip(s.previewChange(update(['skill:two']))); assert.equal(blocked.calls.length,0); }));
 const f = await fixture(); rmSync(join(f.m.paths.repo,'.git'),{ recursive: true,force: true });
 await f.within(s => Effect.gen(function* () { const p = yield* s.previewChange(update(['skill:two'])); assert.equal((yield* submit(s,p.planId)).state,'succeeded'); }));
});


test('scoped prune never claims a completed global prune when another native agent retains shared content', async () => {
 const f = await fixture({ retained: true }); const before = f.m.read(join(f.m.paths.repo,'skills-manifest.txt'));
 await f.within(s => Effect.gen(function* () { const p = yield* s.previewChange(update(['skill:gone'],true)); const run = yield* submit(s,p.planId); assert.equal(run.state,'failed'); assert.ok(!run.parity?.committedKeys.includes('skills:remove')); assert.ok(!run.parity?.committedKeys.includes('skills:manifest')); }));
 assert.equal(existsSync(join(f.m.paths.agentsSkills,'gone')),true); assert.equal(existsSync(join(f.m.paths.claude,'skills/gone')),false); assert.equal(f.m.read(join(f.m.paths.repo,'skills-manifest.txt')),before);
 assert.ok(f.calls.every(c => c.args[1] === 'skills@1.7.2'));
});


test('addition overlaid on a base declaration with a distinct native selector never reaches the generic installer or claims verification', async () => {
 const f = await fixture({ additions: true });
 await f.within(s => Effect.gen(function* () {
  const read = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{})); const row = read.items.find(i => i.name === 'one')!; assert.equal(row.repairRoute,'addition'); assert.match(row.prerequisite!,/resolveSkillCandidate.*previewChange.*applyChange/);
  const p = yield* s.previewChange(update(['skill:one'])); assert.equal(p.plan.steps.length,0); assert.ok(p.plan.skipped.some(row => /native verification/.test(row.reason)));
  const run = yield* submit(s,p.planId); assert.equal(run.installation,undefined); assert.equal(f.calls.length,0);
 }));
});

test('explicit author update preserves a held declaration and exact source discovery never offers adoption', async () => {
 const f = await fixture(); f.m.write(join(f.m.paths.repo,'skills-manifest.txt'),'[owner/repo]\none\ngone\nheld\n');
 f.m.write(join(f.m.paths.stateRoot,'sync.json'),JSON.stringify({ version:1, held: { 'skill:owner/repo/held': H } }));
 await f.within(s => Effect.gen(function* () { const p = yield* s.previewChange(update(['skill:two'],true)); assert.equal((yield* submit(s,p.planId)).state,'succeeded'); }));
 assert.match(f.m.read(join(f.m.paths.repo,'skills-manifest.txt'))!,/held/);
 const exact = await fixture({ exact: true }); await exact.within(s => Effect.gen(function* () { const read = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{})); assert.ok(!read.items.some(i => i.state === 'available')); yield* Effect.flip(s.previewChange(update(['skill:two']))); assert.equal(exact.calls.length,0); }));
});


test('a held skill absent from the author stays absent even when installed locally', async () => {
 const f = await fixture(); f.m.write(join(f.m.paths.repo,'skills-manifest.txt'),'[owner/repo]\none\n');
 f.m.write(join(f.m.paths.stateRoot,'sync.json'),JSON.stringify({ version:1, held: { 'skill:owner/repo/gone': H } }));
 await f.within(s => Effect.gen(function* () { const p = yield* s.previewChange(update(['skill:two'],true)); assert.equal((yield* submit(s,p.planId)).state,'succeeded'); }));
 const author = f.m.read(join(f.m.paths.repo,'skills-manifest.txt'))!; assert.match(author,/one\ntwo/); assert.doesNotMatch(author,/gone/); assert.equal(existsSync(join(f.m.paths.agentsSkills,'gone')),true);
});


test('an addition with missing native lock evidence remains unavailable for generic update and retains its audited repair route', async () => {
 const f = await fixture({ additions:true,missingNative:true }); await f.within(s => Effect.gen(function* () {
  const read = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{})); const item = read.items.find(item => item.name === 'one'); assert.equal(item?.source,'owner/repo'); assert.equal(item?.state,'local'); assert.equal(item?.repairRoute,'addition'); assert.equal(item?.offered,null);
  const p = yield* s.previewChange(update(['skill:one'])); assert.equal(p.plan.steps.length,0); assert.ok(p.plan.skipped.some(item => /native verification/.test(item.reason))); assert.equal(f.calls.length,0);
 }));
});
