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
import { existsSync, mkdirSync, renameSync, rmSync, readFileSync, readdirSync } from 'node:fs';
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
const fixture = async (options: { additions?: boolean; exact?: boolean; author?: boolean; fail?: 'before' | 'after' | 'author' | 'lock'; mapping?: boolean; retained?: boolean; missingNative?: boolean; adoptionNames?: Readonly<Record<string,string>>; metadataCleanup?: boolean; spelled?: string; pinned?: boolean; unreachable?: boolean } = {}) => {
 const m = agentMachine();
 const manifest = `[owner/repo]${options.exact ? ' exact' : ''}\n${options.spelled ?? 'one'}\ngone\n`;
 const pins: Record<string, string> = options.pinned ? { 'skill-pins.json': JSON.stringify({ version: 1, pins: { 'owner/repo': OLD } }) } : {};
 const setup = setupFixture(join(m.root,'snapshot'),{ headFiles: { 'skills-manifest.txt': manifest, ...pins } });
 m.write(join(setup.dirs['a'.repeat(40)]!,'skills-manifest.txt'),manifest);
 for (const [file, text] of Object.entries(pins)) m.write(join(setup.dirs['a'.repeat(40)]!,file),text);
 m.write(join(m.paths.repo,'skills-manifest.txt'),manifest);
 execFileSync('git',['-C',m.paths.repo,'add','.']); execFileSync('git',['-C',m.paths.repo,'-c','user.name=Fixture','-c','user.email=f@f','commit','-qm','fixture']);
 m.write(join(m.paths.repo,'skills-manifest.txt'),manifest + '# dirty author bytes\n');
 const lockPath = join(dirname(m.paths.agentsSkills),'.skill-lock.json');
 const lock: { skills: Record<string, any> } = { skills: {} };
 const entry = (name: string) => ({ source: 'owner/repo', sourceUrl: 'https://github.com/owner/repo.git', skillPath: `s/${name}/SKILL.md`, skillFolderHash: OLD });
 for (const name of ['one','gone']) { lock.skills[name] = entry(name); m.write(join(m.paths.agentsSkills,name,'SKILL.md'),`# ${name}\n`); m.write(join(m.paths.claude,'skills',name,'SKILL.md'),`# old ${name}\n`); }
 if (options.additions) m.write(join(m.paths.stateRoot,'overrides.json'),JSON.stringify({ version: 2, skillAdditions: [{ source: 'owner/repo', name: 'one', targets: ['claude'] }] }));
 if (options.additions) { lock.skills['One'] = lock.skills.one; delete lock.skills.one; if (options.missingNative) delete lock.skills['One']; }
 m.write(lockPath,JSON.stringify(lock)); await m.trust(); const calls: Command[] = []; let metadataReads = 0;
 const compose = <T extends { repo: string }>(snapshot: T) => Effect.gen(function* () { const overrides = yield* Effect.promise(() => m.run(OverridesStore.use(store => store.read))); return { ...snapshot, desired: yield* loadProfile(snapshot.repo,{ overrides }).pipe(Effect.provide(nodeFiles)) }; });
 const source = Layer.succeed(SetupSource,{ ...setup.service,current: setup.service.current.pipe(Effect.flatMap(compose),Effect.orDie), load: revision => setup.service.load(revision).pipe(Effect.flatMap(compose),Effect.orDie), effective: decisions => setup.service.effective(decisions).pipe(Effect.flatMap(value => Effect.gen(function* () { return { ...value, applied: yield* compose(value.applied), effective: yield* compose(value.effective) }; })),Effect.orDie) });
 const within = <A,E>(body: (s: AgentSession) => Effect.Effect<A,E>) => m.run(Effect.scoped(Effect.gen(function* () {
  const fs = yield* Fs; const processes = yield* Processes;
  const fake: Processes['Service'] = { ...processes, run: command => {
   if (command.cmd === 'git' && command.args.includes('credential.interactive=never') && command.args.includes('clone')) return Effect.succeed(options.unreachable
    ? { code: 128, stdout: '', stderr: "fatal: unable to access 'https://x-access-token:PRIVATE_TOKEN@github.com/owner/repo.git/': Could not resolve host: github.com\n" }
    : { code: 0, stdout: '', stderr: '' });
   if (command.cmd === 'git' && command.args[0] === 'ls-tree') return Effect.succeed({ code: 0, stdout: ['one','two','three'].map(n => `040000 tree ${H}\ts/${n}\0` + `100644 blob ${H}\ts/${n}/SKILL.md\0`).join(''), stderr: '' });
   if (command.cmd === 'git' && command.args[0] === '-c') {
    const names = ['one','two','three'];
    const blob = (n: string) => String(names.indexOf(n)+1).repeat(40);
    const content = (n: string) => `---\nname: ${options.adoptionNames?.[n] ?? n}\ndescription: Fixture skill\n---\n# ${n}\n`;
    if (command.args.includes('clone')) { metadataReads++; return Effect.succeed({ code:0,stdout:'',stderr:'' }); }
    if (command.args.includes('rev-parse')) return Effect.succeed({ code:0,stdout:H,stderr:'' });
    if (command.args.includes('ls-tree')) return Effect.succeed({ code:0,stdout:`040000 tree ${H}\ts\0` + names.map(n => `040000 tree ${H}\ts/${n}\0` + `100644 blob ${blob(n)}\ts/${n}/SKILL.md\0`).join(''),stderr:'' });
    if (command.args.includes('cat-file')) { const n = names.find(n => command.args.at(-1) === blob(n))!; const text = content(n); return Effect.succeed({ code:0,stdout:command.args.includes('-s') ? String(Buffer.byteLength(text)) : text,stderr:'' }); }
   }
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
   remove:path => options.metadataCleanup && path.includes('/candidates-') ? Effect.fail(new FsFailed({ op:'cleanup',path,reason:'PRIVATE cleanup' })) : fs.remove(path),
   readBytes: path => options.fail === 'lock' && path === lockPath ? Effect.fail(new FsFailed({ op: 'read', path, reason: 'PRIVATE_READ' })) : fs.readBytes(path),
   writeTextAtomic: (path,text) => options.fail === 'author' && path.endsWith('/checkout/skills-manifest.txt') ? Effect.fail(new FsFailed({ op: 'write', path, reason: 'PRIVATE_AUTHOR' })) : fs.writeTextAtomic(path,text),
  }),Effect.provide(options.mapping === false ? agentSkillInstaller() : agentSkillInstaller({ home: dirname(m.paths.claude) })));
 })),source);
 return { m,setup,within,calls,lockPath,metadataReads:() => metadataReads };
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
  const all = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{ limit: 100 })); assert.equal(all.items.find(i => i.name === 'two')?.offered?.digest,H); assert.equal(all.items.find(i => i.name === 'two')?.repairRoute,'reconcile'); assert.equal(all.items.find(i => i.name === 'gone')?.state,'gone');
  assert.ok(all.items.every(i => i.id === `skill:${i.source}/${i.name}`));
  const next = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{ limit: 1,cursor: first.nextCursor! })); assert.notEqual(first.items[0]?.id,next.items[0]?.id);
  f.m.write(f.lockPath,'{"skills":{}}'); assert.equal((yield* Effect.flip(s.inspectUpdates(decodeOperationInput('inspectUpdates',{ limit: 1,cursor: first.nextCursor! })))).code,'UNKNOWN_PLAN');
 }));
});

// The installer treats skill names case-insensitively: a manifest `One` installed as `one` keeps its pin policy.
// The row stays on the installed name, which update and remove act on.
test('an update row finds its declaration when the manifest name differs in case from the installed skill', async () => {
 const f = await fixture({ spelled: 'One', pinned: true }); await f.within(s => Effect.gen(function* () {
  const all = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{ limit: 100 }));
  const one = all.items.find(i => i.key === 'skill:one')!;
  assert.deepEqual([one.id, one.name, one.state, one.policy, one.offered], ['skill:owner/repo/one', 'one', 'off-pin', 'source-pin', { kind: 'revision', digest: OLD }]);
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

test('author manifest updates are retired without installer or checkout effects', async () => {
 const f = await fixture(); const before = f.m.read(join(f.m.paths.repo,'skills-manifest.txt'));
 await f.within(s => Effect.gen(function* () {
  assert.equal((yield* Effect.flip(s.previewChange(update(['skill:gone','skill:two'],true)))).code, 'INVALID_REQUEST');
  assert.equal(f.calls.length, 0);
 }));
 assert.equal(f.m.read(join(f.m.paths.repo,'skills-manifest.txt')), before);
});

test('partial machine installer outcomes retain recovery facts without author writes', async () => {
 for (const failure of ['before','after'] as const) {
  const f = await fixture({ fail: failure }); const before = f.m.read(join(f.m.paths.repo,'skills-manifest.txt')); let runId = ''; let committed: readonly string[] = [];
  await f.within(s => Effect.gen(function* () {
   const p = yield* s.previewChange(update(['skill:two'])); const run = yield* submit(s,p.planId,failure); runId = run.runId; committed = run.parity?.committedKeys ?? []; assert.equal(run.state,'failed',failure); assert.ok(run.parity?.backupIds.length);
   assert.doesNotMatch(JSON.stringify(run),/PRIVATE/);
   assert.ok(!run.parity?.committedKeys.includes('skills:manifest'));
  }));
  assert.equal(f.m.read(join(f.m.paths.repo,'skills-manifest.txt')),before);
  const callCount = f.calls.length; await f.within(s => Effect.gen(function* () { const recovered = yield* s.runs.get(runId); assert.equal(recovered.state,'failed'); assert.deepEqual(recovered.parity?.committedKeys,committed); assert.equal(f.calls.length,callCount); }));
 }
});

test('holds and native lock changes invalidate previews; unreadable lock never becomes absence', async () => {
 for (const changed of ['lock','holds'] as const) {
  const f = await fixture(); await f.within(s => Effect.gen(function* () {
   const p = yield* s.previewChange(update(['skill:two'])); f.m.write(changed === 'lock' ? f.lockPath : join(f.m.paths.stateRoot,'sync.json'),'{}');
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
 await f.within(s => Effect.gen(function* () { const p = yield* s.previewChange(update(['skill:gone'])); const run = yield* submit(s,p.planId); assert.equal(run.state,'failed'); assert.ok(!run.parity?.committedKeys.includes('skills:remove')); assert.ok(!run.parity?.committedKeys.includes('skills:manifest')); }));
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

// The skills domain plans additions by exact name, so a row whose addition differs only in case is legacy work and
// must pass the legacy native guard rather than be exempted from it. Here a legacy install named `One` (its lock
// entry under the same name) sits beside the addition `one`, so it has no native selector evidence.
test('an addition declared in another case does not exempt the installed row from the legacy native guard', async () => {
 const f = await fixture({ additions: true });
 renameSync(join(f.m.paths.agentsSkills,'one'),join(f.m.paths.agentsSkills,'One'));
 await f.within(s => Effect.gen(function* () {
  const p = yield* s.previewChange(update(['skill:One'])); assert.equal(p.plan.steps.length,0);
  assert.ok(p.plan.skipped.some(item => item.key === 'skill:One' && /native selector evidence/.test(item.reason)), JSON.stringify(p.plan.skipped));
  const run = yield* submit(s,p.planId); assert.equal(run.installation,undefined); assert.equal(f.calls.length,0);
 }));
});

test('an unreachable source says why on its update rows, redacted', async () => {
 const f = await fixture({ unreachable: true }); await f.within(s => Effect.gen(function* () {
  const read = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{ limit: 100 }));
  const one = read.items.find(i => i.name === 'one')!;
  assert.equal(one.state,'unknown');
  assert.equal(one.reason,"Source unreachable: Couldn't reach github.com: Could not resolve host: github.com");
  assert.doesNotMatch(JSON.stringify(read),/PRIVATE_TOKEN/);
  assert.ok(read.items.filter(i => i.state !== 'unknown').every(i => !('reason' in i)), 'only unknown rows carry a reason');
 }));
});

test('machine-only updates preserve held author declarations and exact sources never offer adoption', async () => {
 const f = await fixture(); f.m.write(join(f.m.paths.repo,'skills-manifest.txt'),'[owner/repo]\none\ngone\nheld\n');
 f.m.write(join(f.m.paths.stateRoot,'sync.json'),JSON.stringify({ version:1, held: { 'skill:owner/repo/held': H } }));
 await f.within(s => Effect.gen(function* () { const p = yield* s.previewChange(update(['skill:two'])); assert.equal((yield* submit(s,p.planId)).state,'succeeded'); }));
 assert.match(f.m.read(join(f.m.paths.repo,'skills-manifest.txt'))!,/held/);
 const exact = await fixture({ exact: true }); await exact.within(s => Effect.gen(function* () { const read = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{})); assert.ok(!read.items.some(i => i.state === 'available')); yield* Effect.flip(s.previewChange(update(['skill:two']))); assert.equal(exact.calls.length,0); }));
});


test('a held skill absent from the author stays absent even when installed locally', async () => {
 const f = await fixture(); f.m.write(join(f.m.paths.repo,'skills-manifest.txt'),'[owner/repo]\none\n');
 f.m.write(join(f.m.paths.stateRoot,'sync.json'),JSON.stringify({ version:1, held: { 'skill:owner/repo/gone': H } }));
 await f.within(s => Effect.gen(function* () { const p = yield* s.previewChange(update(['skill:two'])); assert.equal((yield* submit(s,p.planId)).state,'succeeded'); }));
 const author = f.m.read(join(f.m.paths.repo,'skills-manifest.txt'))!; assert.equal(author,'[owner/repo]\none\n'); assert.doesNotMatch(author,/gone/); assert.equal(existsSync(join(f.m.paths.agentsSkills,'gone')),true);
});


test('an addition with missing native lock evidence remains unavailable for generic update and retains its audited repair route', async () => {
 const f = await fixture({ additions:true,missingNative:true }); await f.within(s => Effect.gen(function* () {
  const read = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{})); const item = read.items.find(item => item.name === 'one'); assert.equal(item?.source,'owner/repo'); assert.equal(item?.state,'local'); assert.equal(item?.repairRoute,'addition'); assert.equal(item?.offered,null);
  const p = yield* s.previewChange(update(['skill:one'])); assert.equal(p.plan.steps.length,0); assert.ok(p.plan.skipped.some(item => /native verification/.test(item.reason))); assert.equal(f.calls.length,0);
 }));
});


test('available adoption requires matching native metadata identity, including a same-source folder/name collision', async () => {
 for (const adoptionNames of [{ two:'native-two' },{ two:'native-two',three:'two' }] as readonly Readonly<Record<string,string>>[]) {
  const f = await fixture({ adoptionNames }); await f.within(s => Effect.gen(function* () {
   const read = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{})); const offer = read.items.find(i => i.name === 'two')!;
   assert.equal(offer.repairRoute,'addition'); assert.match(offer.prerequisite!,/resolveSkillCandidate.*previewChange.*applyChange/);
   const p = yield* s.previewChange(update(['skill:two'])); assert.equal(p.plan.steps.length,0); assert.ok(p.plan.skipped.some(i => /resolveSkillCandidate/.test(i.reason))); assert.equal(f.calls.length,0);
  }));
 }
});

test('update inspection refuses old inspection/new generation and changes during upstream observation', async () => {
 for (const seam of ['inspection','upstream'] as const) {
  const m = agentMachine(); let generation = 0;
  const desired = { files:[],integrations:[],allow:{},issues:[],skills:[{ name:'one',source:'owner/repo',exact:false,optional:false,install:true,targets:['claude'] as const,from:{ layer:'base' as const,source:'skills-manifest.txt' } }] };
  const old = { trusted:true,desired,paths:m.paths,report:{ desired,items:[],probeErrors:[] },domains:[skillsDomain],revision:null }; let live = old;
  const change = () => { generation++; live = { ...old,desired:{ ...desired,skills:[{ ...desired.skills[0]!,targets:['codex'] as never }] } }; };
  m.write(join(m.paths.agentsSkills,'one/SKILL.md'),'# one'); m.write(join(dirname(m.paths.agentsSkills),'.skill-lock.json'),JSON.stringify({ skills:{ one:{ source:'owner/repo',sourceUrl:'https://github.com/owner/repo.git',skillPath:'s/one/SKILL.md',skillFolderHash:H } } }));
  let reads=0;
  const handle = { inspection:Effect.sync(() => { const observed = live; if (seam === 'inspection' && reads++ === 0) change(); return observed; }),generation:Effect.sync(() => generation),request:() => Effect.void,exclusive:<A,E,R>(effect:Effect.Effect<A,E,R>) => effect } as unknown as import('../src/agent.ts').AgentHandle;
  await m.run(Effect.scoped(Effect.gen(function* () { const s = yield* makeSession(handle,{ signal:new AbortController().signal,domains:() => [skillsDomain] }); const result = yield* Effect.result(s.inspectUpdates(decodeOperationInput('inspectUpdates',{}))); assert.equal(result._tag,'Failure'); if (result._tag === 'Failure') assert.equal(result.failure.code,'UNKNOWN_PLAN'); })).pipe(Effect.provideService(Processes,{ run:command => Effect.sync(() => { if (seam === 'upstream') change(); return { code:0,stdout:command.args[0] === 'ls-tree' ? `040000 tree ${H}\ts/one\0` + `100644 blob ${H}\ts/one/SKILL.md\0` : '',stderr:'' }; }) })));
 }
});


test('accepted available adoption revalidates exact metadata evidence before effects', async () => {
 const adoptionNames: Record<string,string> = {}; const f = await fixture({ adoptionNames }); await f.within(s => Effect.gen(function* () {
  const p = yield* s.previewChange(update(['skill:two'])); assert.ok(p.plan.steps.some(step => step.touches.includes('skills/two')));
  adoptionNames.two = 'new-selector'; const result = yield* Effect.result(s.runs.submit({ planId:p.planId,requestId:'metadata-stale',inputDigest:operationDigest(p.planId),actor:'mcp' })); assert.equal(result._tag,'Failure'); assert.equal(f.calls.length,0);
 }));
});


test('candidate enrichment reads once per source and unconfirmed cleanup blocks every update effect', async () => {
 const f = await fixture(); await f.within(s => Effect.gen(function* () { const read = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{})); assert.equal(read.items.filter(item => item.state === 'available').length,2); assert.equal(f.metadataReads(),1); }));
 const uncertain = await fixture({ metadataCleanup:true }); await uncertain.within(s => Effect.gen(function* () {
  const read = yield* s.inspectUpdates(decodeOperationInput('inspectUpdates',{})); assert.equal(read.unavailable,true); assert.deepEqual(read.items,[]); assert.doesNotMatch(JSON.stringify(read),/PRIVATE|candidates-/);
  const preview = yield* Effect.result(s.previewChange(update(['skill:one']))); assert.equal(preview._tag,'Failure'); assert.equal(uncertain.calls.length,0);
 })); rmSync(uncertain.m.root,{ recursive:true,force:true });
});

test('cleanup failure after preview refuses unchanged update rows before acceptance or installer effects', async () => {
 const options = { adoptionNames:{ two:'native-two',three:'native-three' },metadataCleanup:false };
 const f = await fixture(options); const lockBefore = f.m.read(f.lockPath); const installedBefore = f.m.read(join(f.m.paths.agentsSkills,'one/SKILL.md'));
 try {
  await f.within(s => Effect.gen(function* () {
   const preview = yield* s.previewChange(update(['skill:one'])); assert.ok(preview.plan.steps.some(step => step.key === 'skills:update'));
   options.metadataCleanup = true;
   const result = yield* Effect.result(s.runs.submit({ planId:preview.planId,requestId:'late-cleanup',inputDigest:operationDigest(preview.planId),actor:'mcp' }));
   assert.equal(result._tag,'Failure'); if (result._tag === 'Failure') { assert.equal(result.failure.code,'UNKNOWN_PLAN'); assert.doesNotMatch(result.failure.message,/PRIVATE|candidates-/); }
   assert.deepEqual((yield* s.runs.list({ limit:10 })).runs,[]); assert.equal(f.calls.length,0);
  }));
  assert.equal(f.m.read(f.lockPath),lockBefore); assert.equal(f.m.read(join(f.m.paths.agentsSkills,'one/SKILL.md')),installedBefore);
 } finally { rmSync(f.m.root,{ recursive:true,force:true }); }
});
