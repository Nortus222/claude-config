import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { Effect } from 'effect';
import { authorMachine } from '../../machine/checks/author-machine.ts';
import { authorDigest, bindAuthorCheckout, executeAuthorEdit, Fs, FsFailed } from '@nortuscc/machine';
import { pinSourceWithServices, prepareSourceEdit } from '../src/index.ts';
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const files = ['skills-manifest.txt', 'skill-pins.json', 'source-ignores.json'];
const source = { source: 'Owner/Repo', url: 'https://github.com/Owner/Repo.git', exact: false, skills: ['one', 'added'] };
const fixture = (t: import('node:test').TestContext) => {
  const m = authorMachine(); t.after(()=>rmSync(m.root,{recursive:true,force:true}));
  m.write(join(m.paths.repo, files[0]!), '[Owner/Repo]\none\n');
  m.write(join(m.paths.repo, files[1]!), '{\r\n  "version": 1,\r\n  "pins": {"Owner/Repo": "' + A + '"}\r\n}\r\n');
  m.write(join(m.paths.repo, files[2]!), '{"version":1,"ignored":{}}\n');
  return m;
};
test('source edits bind exact dirty documents and original declaration keys, backed up by the common author owner', async t => {
  const m = fixture(t), original = m.read(join(m.paths.repo, files[1]!)), index = readFileSync(join(m.paths.repo, '.git/index'));
  const author = await m.run(bindAuthorCheckout(m.paths, files));
  const edit = await m.run(prepareSourceEdit({ author, source, action: 'pin', revision: B }));
  assert.equal(edit.documents.length, 1); assert.equal(edit.documents[0]?.beforeSha256, authorDigest(original));
  assert.equal(JSON.parse(edit.documents[0]!.text).pins['Owner/Repo'], B);
  assert.ok(edit.documents[0]!.text.includes('\r\n'));
  const observed: string[] = [];
  await m.run(executeAuthorEdit(edit, new AbortController().signal, { pending: () => Effect.void, committed: key => Effect.sync(() => { observed.push(key); }) }));
  assert.deepEqual(observed, ['skill-pins.json']); assert.deepEqual(readFileSync(join(m.paths.repo, '.git/index')), index);
});
test('missing author declaration, malformed policies and stale document/HEAD refuse preparation', async t => {
  for (const mutation of ['missing', 'pins', 'ignores', 'bytes', 'head', 'read'] as const) {
    const m = fixture(t);
    if (mutation === 'missing') m.write(join(m.paths.repo, files[0]!), '# machine-only source\n');
    if (mutation === 'pins') m.write(join(m.paths.repo, files[1]!), '{"version":1,"pins":{"Owner/Repo":"bad"}}');
    if (mutation === 'ignores') m.write(join(m.paths.repo, files[2]!), '{"version":1,"ignored":42}');
    const author = await m.run(bindAuthorCheckout(m.paths, files));
    if (mutation === 'bytes') m.write(join(m.paths.repo, files[1]!), '{}');
    if (mutation === 'head') m.git('-c','user.name=Fixture','-c','user.email=f@example.test','commit','--allow-empty','-qm','moved');
    const effect = prepareSourceEdit({ author, source, action: 'ignore', revision: B });
    const checked = mutation !== 'read' ? effect : Effect.gen(function* () {
      const fs = yield* Fs;
      return yield* effect.pipe(Effect.provideService(Fs, { ...fs, readBytes: path => path.endsWith('source-ignores.json') ? Effect.fail(new FsFailed({ op:'read',path:'private',reason:'PRIVATE' })) : fs.readBytes(path) }));
    });
    await assert.rejects(m.run(checked), mutation);
  }
});
test('pin/ignore require exact SHA; reset actions forbid a revision, absent resets do not create files', async t => {
  const m = fixture(t), author = await m.run(bindAuthorCheckout(m.paths, files));
  for (const action of ['pin','ignore'] as const) for (const revision of [undefined,'HEAD',B.toUpperCase(),'b'.repeat(64),B+'\n'])
    await assert.rejects(m.run(prepareSourceEdit({ author,source,action,revision })));
  for (const action of ['unpin','unignore'] as const) await assert.rejects(m.run(prepareSourceEdit({ author,source,action,revision:B })));
  assert.equal((await m.run(prepareSourceEdit({author,source,action:'unignore'}))).documents.length,0);
});

test('duplicate source document keys and invalid ignored revisions refuse rather than normalize dirty intent', async t => {
  for(const text of ['{"version":1,"ignored":{"Owner/Repo":"'+A+'","Owner/Repo":"'+B+'"}}','{"version":1,"ignored":{"other":"bad"}}']) {
    const m=fixture(t);m.write(join(m.paths.repo,'source-ignores.json'),text);
    const author=await m.run(bindAuthorCheckout(m.paths,files));
    await assert.rejects(m.run(prepareSourceEdit({author,source,action:'ignore',revision:B})));
    assert.equal(m.read(join(m.paths.repo,'source-ignores.json')),text);
  }
});

test('an interrupted author write preserves exact dirty bytes and its already-created backup', async t => {
  const m=fixture(t), original=m.read(join(m.paths.repo,'skill-pins.json'));
  const author=await m.run(bindAuthorCheckout(m.paths,files)), edit=await m.run(prepareSourceEdit({author,source,action:'pin',revision:B}));
  let committed=false;
  const result=await m.run(Effect.gen(function*(){
    const fs=yield* Fs;
    return yield* Effect.exit(executeAuthorEdit(edit,new AbortController().signal,{pending:()=>Effect.void,committed:()=>Effect.sync(()=>{committed=true;})}).pipe(Effect.provideService(Fs,{...fs,writeTextAtomic:()=>Effect.fail(new FsFailed({op:'write',path:'private',reason:'private'}))})));
  }));
  assert.equal(result._tag,'Failure');assert.equal(committed,false);assert.equal(m.read(join(m.paths.repo,'skill-pins.json')),original);
  const backup=readdirSync(m.paths.backups)[0]!;assert.equal(m.read(join(m.paths.backups,backup,'author/skill-pins.json')),original);
});

test('service-based source writes use the supplied clock and keep exclusive backup collisions',async t=>{
  const m=fixture(t),before=m.read(join(m.paths.repo,'skill-pins.json')),dir=join(m.paths.backups,'standalone'),at=new Date('2026-10-14T01:02:03.004Z');
  const first=await m.run(pinSourceWithServices(m.paths.repo,source.source,B,{backupDir:dir},at));
  assert.equal(first.backup,join(dir,'skill-pins.json.20261014T010203004Z'));assert.equal(m.read(first.backup!),before);
  const second=await m.run(pinSourceWithServices(m.paths.repo,source.source,A,{backupDir:dir},at));
  assert.equal(second.backup,first.backup+'-1');assert.equal(m.read(first.backup!),before);
});

test('a failed exclusive backup is never accepted as a collision or retried over partial evidence',async t=>{
  const m=fixture(t),before=m.read(join(m.paths.repo,'skill-pins.json'));let copies=0;
  await assert.rejects(m.run(Effect.gen(function*(){
    const fs=yield* Fs;
    return yield* pinSourceWithServices(m.paths.repo,source.source,B,{backupDir:m.paths.backups},new Date('2026-10-14T01:02:03.004Z')).pipe(Effect.provideService(Fs,{...fs,copy:(from,to,options)=>Effect.suspend(()=>{
      copies++;if(copies>1)return fs.copy(from,to,options);m.write(to,'partial backup');return Effect.fail(new FsFailed({op:'copy',path:'PRIVATE',reason:'PRIVATE'}));
    })}));
  })));
  assert.equal(copies,1);assert.equal(m.read(join(m.paths.repo,'skill-pins.json')),before);
  assert.equal(m.read(join(m.paths.backups,'skill-pins.json.20261014T010203004Z')),'partial backup');
});
