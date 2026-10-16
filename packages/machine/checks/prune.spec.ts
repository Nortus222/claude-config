import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import {
  backupFolderTime, backupsToPrune, HistoryStore, historyStore, machinePaths, nodeFs, pruneBackups,
  type Fs, type MachinePaths,
} from '../src/index.ts';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
// The name backupsForRun gives a run's folder.
const folderAt = (date: Date) => `nortuscc-${date.toISOString().replace(/[:.]/g, '-')}`;

test('backupFolderTime reads only the names backupsForRun makes', () => {
  assert.equal(backupFolderTime(folderAt(NOW)), NOW.getTime());
  assert.equal(backupFolderTime('nortuscc-not-a-date'), undefined);
  assert.equal(backupFolderTime('.DS_Store'), undefined);
});

test('only folders older than 90 days and outside the newest 20 are chosen', () => {
  const old = Array.from({ length: 25 }, (_, i) => folderAt(daysAgo(100 + i)));
  assert.deepEqual(backupsToPrune(old, NOW), old.slice(20));
  const recent = Array.from({ length: 25 }, (_, i) => folderAt(daysAgo(i)));
  assert.deepEqual(backupsToPrune(recent, NOW), []);
  const mixed = [...Array.from({ length: 20 }, (_, i) => folderAt(daysAgo(i))), ...[50, 60, 95, 100, 200].map((d) => folderAt(daysAgo(d)))];
  assert.deepEqual(backupsToPrune(mixed, NOW), [95, 100, 200].map((d) => folderAt(daysAgo(d))));
});

test('the kept folder and names backupsForRun did not make are never chosen', () => {
  const names = [...Array.from({ length: 21 }, (_, i) => folderAt(daysAgo(100 + i))), 'manual-copy'];
  assert.deepEqual(backupsToPrune(names, NOW, names[20]), []);
});

const machine = () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-prune-'));
  const stateRoot = join(root, 'state');
  const paths = {
    repo: root, claude: root, codex: root, codexOpenRouter: root, agentsSkills: root, stateRoot, backups: join(stateRoot, 'backups'),
  };
  const layer = historyStore().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const run = <A, E>(effect: Effect.Effect<A, E, HistoryStore | MachinePaths | Fs>) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return { paths, run };
};

const finished = (backup: string) => ({ kind: 'apply-finished', actor: 'agent', runId: backup, steps: [], backup, result: 'done' } as const);

test('pruneBackups removes old folders, keeps the latest one History references, and records what it removed', async () => {
  const { paths, run } = machine();
  const names = Array.from({ length: 22 }, (_, i) => folderAt(daysAgo(100 + i)));
  for (const name of names) mkdirSync(join(paths.backups, name), { recursive: true });
  // The oldest run first, then the run whose folder is History's latest reference.
  await run(HistoryStore.use((h) => Effect.andThen(
    h.append(finished(join(paths.backups, names[21]!))),
    h.append(finished(join(paths.backups, names[20]!))),
  )));

  const removed = await run(pruneBackups(NOW, 'agent'));

  assert.deepEqual(removed, [join(paths.backups, names[21]!)]);
  assert.deepEqual(readdirSync(paths.backups).sort(), names.slice(0, 21).sort());
  const [older, latest, pruned] = await run(HistoryStore.use((h) => h.read));
  assert.ok(pruned?.kind === 'backups-pruned');
  assert.deepEqual(pruned.folders, removed);
  assert.ok(older?.kind === 'apply-finished' && latest?.kind === 'apply-finished');
  assert.equal(older.backup, 'pruned');
  assert.equal(latest.backup, join(paths.backups, names[20]!));
});

test('pruneBackups with nothing to remove records nothing', async () => {
  const { paths, run } = machine();
  mkdirSync(join(paths.backups, folderAt(daysAgo(200))), { recursive: true });
  assert.deepEqual(await run(pruneBackups(NOW, 'agent')), []);
  assert.deepEqual(await run(HistoryStore.use((h) => h.read)), []);
});

test('generated names reject normalized invalid dates and exact ninety-day boundary is retained', () => {
  assert.equal(backupFolderTime('nortuscc-2026-02-30T00-00-00-000Z'), undefined);
  const names = [...Array.from({length:20},(_,i)=>folderAt(daysAgo(i))),folderAt(daysAgo(90))];
  assert.deepEqual(backupsToPrune(names,NOW),[]);
});

test('exact retention owner excludes links/files, binds inventory and caps each accepted batch', async () => {
  const {paths,run}=machine();
  const {inspectBackupFolders,planBackupPrune,executeBackupPrune}=await import('../src/index.ts');
  const {symlinkSync,writeFileSync,rmSync}=await import('node:fs');
  try {
    const names=Array.from({length:122},(_,i)=>folderAt(daysAgo(100+i)));
    for(const name of names)mkdirSync(join(paths.backups,name),{recursive:true});
    const link=folderAt(daysAgo(500)),file=folderAt(daysAgo(501));
    symlinkSync(paths.repo,join(paths.backups,link));writeFileSync(join(paths.backups,file),'private');
    assert.equal((await run(inspectBackupFolders())).length,122);
    const plan=await run(planBackupPrune(NOW));assert.equal(plan.folderIds.length,100);assert.equal(plan.limited,true);
    mkdirSync(join(paths.backups,folderAt(daysAgo(502))));
    await assert.rejects(run(executeBackupPrune(plan,'mcp',{pending:()=>Effect.void,committed:()=>Effect.void})));
    assert.equal(readdirSync(paths.backups).length,125);
  }finally{rmSync(paths.repo,{recursive:true,force:true})}
});

test('executor stops at removal two, records removal one and never copies backups',async()=>{
 const {paths,run}=machine();
 const {Fs:FsService,FsFailed,planBackupPrune,executeBackupPrune}=await import('../src/index.ts');
 const {rmSync}=await import('node:fs');
 try{
  const names=Array.from({length:23},(_,i)=>folderAt(daysAgo(100+i)));
  for(const id of names)mkdirSync(join(paths.backups,id),{recursive:true});
  const result=await run(Effect.gen(function*(){
   const fs=yield* FsService;let removes=0;
   const plan=yield* planBackupPrune(NOW);
   return yield* executeBackupPrune(plan,'mcp',{pending:()=>Effect.void,committed:()=>Effect.void}).pipe(Effect.provideService(FsService,{...fs,copy:()=>Effect.die('backup-of-backups'),remove:path=>++removes===2?Effect.fail(new FsFailed({op:'remove',path,reason:'fixture'})):fs.remove(path)}));
  }));
  assert.deepEqual(result,{removed:[names[20]],remaining:names.slice(21),failedId:names[21]});
  const events=await run(HistoryStore.use(h=>h.read));assert.equal(events.length,1);
  assert.deepEqual(events[0]?.kind==='backups-pruned'&&events[0].folders,[join(paths.backups,names[20]!)]);
 }finally{rmSync(paths.repo,{recursive:true,force:true})}
});

test('pending can interrupt before deletion and a swapped symlink never deletes its target',async()=>{
 const {paths,run}=machine();
 const {planBackupPrune,executeBackupPrune}=await import('../src/index.ts');
 const {rmSync,symlinkSync,existsSync}=await import('node:fs');
 try{
  const names=Array.from({length:21},(_,i)=>folderAt(daysAgo(100+i)));
  for(const id of names)mkdirSync(join(paths.backups,id),{recursive:true});
  const plan=await run(planBackupPrune(NOW));
  await assert.rejects(run(executeBackupPrune(plan,'mcp',{pending:()=>Effect.fail('receipt unavailable'),committed:()=>Effect.void})));
  assert.ok(existsSync(join(paths.backups,names[20]!)));
  const result=await run(executeBackupPrune(plan,'mcp',{pending:()=>Effect.sync(()=>{rmSync(join(paths.backups,names[20]!),{recursive:true});symlinkSync(paths.repo,join(paths.backups,names[20]!))}),committed:()=>Effect.void}));
  assert.equal(result.failedId,names[20]);assert.deepEqual(result.removed,[]);assert.ok(existsSync(paths.repo));
 }finally{rmSync(paths.repo,{recursive:true,force:true})}
});

test('automatic retention skips a held common lock and maintenance, and under-lock wrapper does not reacquire',async()=>{
 const {paths,run}=machine();
 const {acquireApplyLock}=await import('../src/index.ts');
 const {rmSync,writeFileSync}=await import('node:fs');
 try{
  const names=Array.from({length:21},(_,i)=>folderAt(daysAgo(100+i)));
  for(const id of names)mkdirSync(join(paths.backups,id),{recursive:true});
  await run(Effect.scoped(Effect.gen(function*(){yield* acquireApplyLock;assert.deepEqual(yield* pruneBackups(NOW,'agent'),[]);assert.deepEqual(yield* pruneBackups(NOW,'agent',{lockHeld:true}),[join(paths.backups,names[20]!)]);})));
  mkdirSync(join(paths.stateRoot,'agent'),{recursive:true});writeFileSync(join(paths.stateRoot,'agent','pending-update.json'),'{}');
  assert.deepEqual(await run(pruneBackups(NOW,'agent')),[]);
 }finally{rmSync(paths.repo,{recursive:true,force:true})}
});

test('limited cleanup deletes exactly the accepted hundred then needs a fresh plan',async()=>{
 const {paths,run}=machine();
 const {planBackupPrune,executeBackupPrune}=await import('../src/index.ts');const {rmSync}=await import('node:fs');
 try{
  const names=Array.from({length:122},(_,i)=>folderAt(daysAgo(100+i)));
  for(const id of names)mkdirSync(join(paths.backups,id),{recursive:true});
  const plan=await run(planBackupPrune(NOW));const observed:string[]=[];
  const result=await run(executeBackupPrune(plan,'mcp',{pending:()=>Effect.void,committed:id=>Effect.sync(()=>{observed.push(id)})}));
  assert.deepEqual(result.removed,names.slice(20,120));assert.deepEqual(observed,result.removed);assert.deepEqual(result.remaining,[]);
  const events=await run(HistoryStore.use(h=>h.read));assert.equal(events[0]?.kind==='backups-pruned'&&events[0].limited,true);
  await assert.rejects(run(executeBackupPrune(plan,'mcp',{pending:()=>Effect.die('replayed'),committed:()=>Effect.void})));
  const next=await run(planBackupPrune(NOW));assert.deepEqual(next.folderIds,names.slice(120));assert.equal(next.limited,false);
 }finally{rmSync(paths.repo,{recursive:true,force:true})}
});

test('a changed latest History reference invalidates the exact retention preview',async()=>{
 const {paths,run}=machine();const {planBackupPrune,executeBackupPrune}=await import('../src/index.ts');const {rmSync}=await import('node:fs');
 try{
  const names=Array.from({length:22},(_,i)=>folderAt(daysAgo(100+i)));
  for(const id of names)mkdirSync(join(paths.backups,id),{recursive:true});
  const plan=await run(planBackupPrune(NOW));await run(HistoryStore.use(h=>h.append(finished(join(paths.backups,names[21]!)))));
  await assert.rejects(run(executeBackupPrune(plan,'mcp',{pending:()=>Effect.die('effect before stale refusal'),committed:()=>Effect.void})));
  const fresh=await run(planBackupPrune(NOW));assert.equal(fresh.keepId,names[21]);assert.deepEqual(fresh.folderIds,[names[20]]);
 }finally{rmSync(paths.repo,{recursive:true,force:true})}
});
