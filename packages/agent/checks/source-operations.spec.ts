import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOperationInput, decodeOperationOutput, operationDefinitions } from '../src/operations/index.ts';
test('four source reads have strict bounded inputs with no caller paths', () => {
  for (const name of ['watchSources', 'inspectSourceDiff', 'pinImpact', 'draftChangelog'])
    assert.ok(name in operationDefinitions, name);
  const local={sourceId:'a/b',localObservation:'a'.repeat(64),skillId:'skill:a/b/one'};
  assert.equal(decodeOperationInput('inspectSourceDiff',local).skillId,local.skillId);
  for(const extra of [{fromRevision:'b'.repeat(40),toRevision:'c'.repeat(40)},{path:'/private'}, {localObservation:'HEAD'}])
    assert.throws(()=>decodeOperationInput('inspectSourceDiff',{...local,...extra}));
  assert.throws(()=>decodeOperationOutput('inspectSourceDiff',{generation:'1',...local,state:'complete',text:'',nextCursor:null,path:'/private'}));
  assert.equal(decodeOperationInput('watchSources', {}).limit, 8);
  assert.throws(() => decodeOperationInput('watchSources', { limit: 9 }));
  assert.throws(() => decodeOperationInput('watchSources', { sourceIds: Array(9).fill('a/b') }));
  assert.throws(() => decodeOperationInput('watchSources', { path: '/private' }));
  assert.throws(() => decodeOperationInput('pinImpact', { sourceId: 'a/b', revision: '--upload-pack=evil' }));
  assert.throws(() =>
    decodeOperationInput('draftChangelog', {
      accepted: Array(9).fill({ sourceId: 'a/b', fromRevision: 'a'.repeat(40), toRevision: 'b'.repeat(40) }),
    }),
  );
});

import { Effect, Layer } from 'effect';
import { join, resolve, sep } from 'node:path';
import { rmSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { Processes, DecisionsStore } from '@nortuscc/machine';
import { makeRepo, tempDir, gitSync, commitFiles } from '../../source-watch/checks/fixtures.ts';
import { agentMachine } from './support/agent-machine.ts';
import { setupFixture, accept, EFFORT } from './support/setup-fixture.ts';
import { startAgent, makeSession } from '../src/index.ts';
import { sourceEnvironment, sourceIdentity } from '../src/operations/sources.ts';

// Real Git stays inside temporary sources. URL routing is a trusted process fixture, not wire input.
test('actual session reads source-wide changes, exact diffs, selected draft and stale SHA cursors without intent writes', async (t) => {
  const root = tempDir(t),
    repo = makeRepo(root),
    other = makeRepo(root, 'other');
  const from = repo.commit('baseline', { 'skills/one/SKILL.md': 'old\n', 'skills/two/SKILL.md': 'stable\n' });
  const to = repo.commit('update one', {
    'skills/one/SKILL.md': 'new\n' + 'A'.repeat(40000),
    'skills/added/SKILL.md': 'added\n',
  });
  other.commit('other', { 'skills/three/SKILL.md': 'three' });
  const m = agentMachine();
  t.after(() => rmSync(m.root, { recursive: true, force: true }));
  await m.trust();
  await m.run(DecisionsStore.use((store) => store.record(accept(EFFORT))));
  const fixture = setupFixture(join(m.root, 'setup'), {
    headFiles: {
      'skills-manifest.txt': '[owner/repo]\none\ntwo\n[other/repo]\nthree\n[https://github.com/owner/repo.git]\ntwo\n',
      'skill-pins.json': JSON.stringify({ version: 1, pins: { 'owner/repo': from } }),
    },
  });
  await m.run(
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* startAgent(() => m.domains, { deferStart: true });
        const processes = yield* Processes;
        const session = yield* makeSession(h, { domains: () => m.domains, signal: new AbortController().signal }).pipe(
          Effect.provide(
            sourceEnvironment({
              PATH: process.env.PATH!,
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_ALLOW_PROTOCOL: 'file',
            }),
          ),
          Effect.provideService(Processes, {
            run: (command) =>
              processes.run({
                ...command,
                args: command.args.map((a) =>
                  a === 'https://github.com/owner/repo.git'
                    ? repo.url
                    : a === 'https://github.com/other/repo.git'
                      ? other.url
                      : a,
                ),
              }),
          }),
        );
        yield* session.inspect('mcp');
        const documents = ['skills-manifest.txt', 'skill-pins.json', 'skill-ignores.json'].map((p) => [
          join(m.paths.repo, p),
          m.read(join(m.paths.repo, p)),
        ]);
        const overrides = m.read(join(m.paths.stateRoot, 'overrides.json'));
        const aliases = yield* session.watchSources(decodeOperationInput('watchSources', {sourceIds:['owner/repo',sourceIdentity('https://github.com/owner/repo.git')]}));
        assert.equal(aliases.state,'complete'); assert.equal(aliases.items.length,2);
        assert.equal(aliases.items[0]?.fromRevision,from);assert.equal(aliases.items[1]?.fromRevision,null);
        assert.deepEqual(aliases.items[1]?.skills.map(s=>s.name),['two']);
        assert.ok(!readdirSync(join(m.paths.stateRoot,'source-watch')).some(n=>n.endsWith('.cleanup-uncertain')));
        const first = yield* session.watchSources(decodeOperationInput('watchSources', { limit: 1 }));
        assert.equal(first.state, 'complete');
        assert.ok(first.nextCursor);
        assert.equal(first.items[0]?.toRevision, to);
        const second = yield* session.watchSources(
          decodeOperationInput('watchSources', { limit: 1, cursor: first.nextCursor! }),
        );
        assert.equal(second.items[0]?.sourceId, 'other/repo');
        const impact = yield* session.pinImpact(
          decodeOperationInput('pinImpact', { sourceId: 'owner/repo', revision: to }),
        );
        assert.equal(impact.skills.length, 2);
        assert.equal(impact.toRevision, to);
        const diff = yield* session.inspectSourceDiff(
          decodeOperationInput('inspectSourceDiff', {
            sourceId: 'owner/repo',
            fromRevision: from,
            toRevision: to,
            skillId: 'skill:owner/repo/one',
          }),
        );
        assert.match(diff.text, /new/);
        assert.equal(diff.state, 'limited');
        assert.ok(Buffer.byteLength(diff.text) <= 32768);
        assert.ok(diff.nextCursor);
        const rest = yield* session.inspectSourceDiff(
          decodeOperationInput('inspectSourceDiff', {
            sourceId: 'owner/repo',
            fromRevision: from,
            toRevision: to,
            skillId: 'skill:owner/repo/one',
            cursor: diff.nextCursor!,
          }),
        );
        assert.equal(rest.state, 'complete');
        assert.ok(Buffer.byteLength(rest.text) <= 32768);
        assert.ok((diff.text + rest.text).includes('A'.repeat(40000)));
        yield* Effect.flip(
          session.inspectSourceDiff(
            decodeOperationInput('inspectSourceDiff', {
              sourceId: 'owner/repo',
              fromRevision: from,
              toRevision: to,
              skillId: 'skill:owner/repo/two',
              cursor: diff.nextCursor!,
            }),
          ),
        );
        const drafted = yield* session.draftChangelog(
          decodeOperationInput('draftChangelog', {
            accepted: [
              { sourceId: 'owner/repo', fromRevision: from, toRevision: to, ignored: ['one'], added: ['added'] },
              { sourceId: sourceIdentity('https://github.com/owner/repo.git'), fromRevision:from,toRevision:to },
            ],
          }),
        );
        assert.match(drafted.text, /Added `added`/);
        assert.match(drafted.text, /Also updated: `one`/);
        yield* Effect.flip(
          session.draftChangelog(
            decodeOperationInput('draftChangelog', {
              accepted: [{ sourceId: 'owner/repo', fromRevision: from, toRevision: to, added: ['invented'] }],
            }),
          ),
        );
        yield* Effect.flip(session.watchSources(decodeOperationInput('watchSources', { sourceIds: ['unknown/repo'] })));
        repo.commit('moving source', { 'skills/one/SKILL.md': 'newer' });
        yield* session.watchSources(decodeOperationInput('watchSources', { sourceIds: ['owner/repo'] }));
        assert.equal(
          (yield* Effect.flip(
            session.watchSources(decodeOperationInput('watchSources', { limit: 1, cursor: first.nextCursor! })),
          )).code,
          'UNKNOWN_PLAN',
        );
        assert.equal(m.read(join(m.paths.stateRoot, 'overrides.json')), overrides);
        for (const [path, bytes] of documents) assert.equal(m.read(path!), bytes);
        assert.equal(gitSync(repo.dir, 'status', '--porcelain'), '');
      }),
    ),
    fixture.source,
  );
});

test('more than eight known sources paginate without re-reading unrelated pages; untrusted reads refuse', async (t) => {
  const root = tempDir(t),
    repo = makeRepo(root);
  repo.commit('skills', { 'skills/one/SKILL.md': 'one' });
  const m = agentMachine();
  t.after(() => rmSync(m.root, { recursive: true, force: true }));
  const manifest = Array.from({ length: 10 }, (_, i) => `[owner/repo${i}]\none\n`).join('');
  const fixture = setupFixture(join(m.root, 'setup'), { headFiles: { 'skills-manifest.txt': manifest } });
  await m.run(DecisionsStore.use((store) => store.record(accept(EFFORT))));
  await m.run(
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* startAgent(() => m.domains, { deferStart: true });
        const s = yield* makeSession(h, { domains: () => m.domains, signal: new AbortController().signal }).pipe(
          Effect.provide(sourceEnvironment({})),
        );
        yield* s.inspect('mcp');
        assert.equal(
          (yield* Effect.flip(s.watchSources(decodeOperationInput('watchSources', {})))).code,
          'APP_UNAVAILABLE',
        );
      }),
    ),
    fixture.source,
  );
  await m.trust();
  await m.run(
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* startAgent(() => m.domains, { deferStart: true });
        const processes = yield* Processes;
        let clones = 0;
        const s = yield* makeSession(h, { domains: () => m.domains, signal: new AbortController().signal }).pipe(
          Effect.provide(
            sourceEnvironment({
              PATH: process.env.PATH!,
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_ALLOW_PROTOCOL: 'file',
            }),
          ),
          Effect.provideService(Processes, {
            run: (c) => {
              if (c.args[0] === 'clone') clones++;
              return processes.run({
                ...c,
                args: c.args.map((a) => (a.startsWith('https://github.com/owner/repo') ? repo.url : a)),
              });
            },
          }),
        );
        yield* s.inspect('mcp');
        const first = yield* s.watchSources(decodeOperationInput('watchSources', {}));
        assert.equal(first.items.length, 8);
        assert.ok(first.nextCursor);
        assert.equal(clones, 8);
        const second = yield* s.watchSources(decodeOperationInput('watchSources', { cursor: first.nextCursor! }));
        assert.equal(second.items.length, 2);
        assert.equal(second.nextCursor, null);
        assert.equal(clones, 10);
        assert.deepEqual(
          [...first.items, ...second.items].map((r) => r.sourceId),
          Array.from({ length: 10 }, (_, i) => `owner/repo${i}`),
        );
        yield* s.inspect('mcp');
        assert.equal(
          (yield* Effect.flip(s.watchSources(decodeOperationInput('watchSources', { cursor: first.nextCursor! }))))
            .code,
          'UNKNOWN_PLAN',
        );
      }),
    ),
    fixture.source,
  );
});

test('source cleanup uncertainty is safe, persistent, and prevents cache reuse', async (t) => {
  const m = agentMachine();
  t.after(() => rmSync(m.root, { recursive: true, force: true }));
  await m.trust();
  await m.run(DecisionsStore.use((store) => store.record(accept(EFFORT))));
  const fixture = setupFixture(join(m.root, 'setup'), { headFiles: { 'skills-manifest.txt': '[owner/repo]\none\n[https://github.com/owner/repo.git]\none\n' } });
  await m.run(
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* startAgent(() => m.domains, { deferStart: true });
        let reads = 0;
        const s = yield* makeSession(h, { domains: () => m.domains, signal: new AbortController().signal }).pipe(
          Effect.provide(sourceEnvironment({})),
          Effect.provideService(Processes, {
            run: (c) => {
              reads++;
              c.onCleanup?.({ joined: false });
              return Effect.succeed({ code: 1, stdout: '', stderr: 'private /home/private token=secret' });
            },
          }),
        );
        yield* s.inspect('mcp');
        const result = yield* s.watchSources(decodeOperationInput('watchSources', {}));
        assert.equal(result.reason, 'cleanup-failed');
        assert.equal(result.retainedCache, true);
        assert.doesNotMatch(JSON.stringify(result), /private|secret/);
        const calls = reads;
        const retried = yield* s.watchSources(decodeOperationInput('watchSources', {}));
        assert.equal(retried.reason, 'cleanup-failed');
        assert.equal(reads, calls);
        const draft = yield* s.draftChangelog(decodeOperationInput('draftChangelog', { accepted: [
          { sourceId: 'owner/repo', fromRevision: 'a'.repeat(40), toRevision: 'b'.repeat(40) },
          { sourceId: sourceIdentity('https://github.com/owner/repo.git'), fromRevision: 'a'.repeat(40), toRevision: 'b'.repeat(40) },
        ] }));
        assert.equal(draft.reason, 'cleanup-failed'); assert.equal(reads, calls);
      }),
    ),
    fixture.source,
  );
});

import { AgentClock } from '../src/clock.ts';
test('aggregate deadline joins both active readers and preserves mixed cleanup uncertainty', async (t) => {
  const m = agentMachine();
  t.after(() => rmSync(m.root, { recursive: true, force: true }));
  await m.trust();
  await m.run(DecisionsStore.use((store) => store.record(accept(EFFORT))));
  const fixture = setupFixture(join(m.root, 'setup'), {
    headFiles: { 'skills-manifest.txt': '[owner/one]\none\n[owner/two]\ntwo\n' },
  });
  await m.run(
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* startAgent(() => m.domains, { deferStart: true });
        let active = 0,
          joined = 0,
          peak = 0;
        const s = yield* makeSession(h, { domains: () => m.domains, signal: new AbortController().signal }).pipe(
          Effect.provide(sourceEnvironment({})),
          Effect.provideService(AgentClock, {
            now: Effect.succeed(new Date('2026-10-14T00:00:00Z')),
            random: Effect.succeed(0),
            sleep: () => Effect.sleep(25),
          }),
          Effect.provideService(Processes, {
            run: (c) =>
              Effect.suspend(() => {
                active++;
                peak = Math.max(peak, active);
                return Effect.never.pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      active--;
                      joined++;
                      c.onCleanup?.({ joined: false });
                    }),
                  ),
                );
              }),
          }),
        );
        yield* s.inspect('mcp');
        const result = yield* s.watchSources(decodeOperationInput('watchSources', {}));
        assert.equal(result.reason, 'cleanup-failed');
        assert.equal(result.retainedCache, true);
        assert.equal(active, 0);
        assert.equal(joined, 2);
        assert.equal(peak, 2);
      }),
    ),
    fixture.source,
  );
});

test('same-generation inspection replacement during source work refuses the mixed observation', async (t) => {
  const m = agentMachine();
  t.after(() => rmSync(m.root, { recursive: true, force: true }));
  await m.trust();
  await m.run(DecisionsStore.use((store) => store.record(accept(EFFORT))));
  const fixture = setupFixture(join(m.root, 'setup'), { headFiles: { 'skills-manifest.txt': '[owner/repo]\none\n' } });
  await m.run(
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* startAgent(() => m.domains, { deferStart: true });
        let changed = false;
        const wrapped = {
          ...h,
          inspection: h.inspection.pipe(Effect.map((value) => (changed && value ? { ...value } : value))),
        };
        const s = yield* makeSession(wrapped, { domains: () => m.domains, signal: new AbortController().signal }).pipe(
          Effect.provide(sourceEnvironment({})),
          Effect.provideService(Processes, {
            run: () => {
              changed = true;
              return Effect.succeed({ code: 1, stdout: '', stderr: 'private fixture error' });
            },
          }),
        );
        yield* s.inspect('mcp');
        const generation = yield* h.generation!;
        assert.equal(
          (yield* Effect.flip(s.watchSources(decodeOperationInput('watchSources', {})))).code,
          'UNKNOWN_PLAN',
        );
        assert.equal(yield* h.generation!, generation);
      }),
    ),
    fixture.source,
  );
});

test('declared URL and case-sensitive source identities remain exact; untrusted file sources never reach Git', async (t) => {
  const root = tempDir(t),
    repo = makeRepo(root);
  repo.commit('one', { 'skills/one/SKILL.md': 'one' });
  const m = agentMachine();
  t.after(() => rmSync(m.root, { recursive: true, force: true }));
  await m.trust();
  await m.run(DecisionsStore.use((store) => store.record(accept(EFFORT))));
  const url = 'https://gitlab.com/Owner/Repo.git',
    mixed = 'Nortus222/agent-skills',
    ssh = 'git@code.example:team/repo.git',
    local = 'file:///private/not-configured';
  const fixture = setupFixture(join(m.root, 'setup'), {
    headFiles: { 'skills-manifest.txt': `[${url}]\none\n[${mixed}]\none\n[${ssh}]\none\n[${local}]\none\n` },
  });
  await m.run(
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* startAgent(() => m.domains, { deferStart: true }),
          processes = yield* Processes;
        let calls = 0;
        const s = yield* makeSession(h, { domains: () => m.domains, signal: new AbortController().signal }).pipe(
          Effect.provide(
            sourceEnvironment({
              PATH: process.env.PATH!,
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_ALLOW_PROTOCOL: 'file',
            }),
          ),
          Effect.provideService(Processes, {
            run: (c) => {
              calls++;
              return processes.run({
                ...c,
                args: c.args.map((a) => (a === url || a === ssh || a === `https://github.com/${mixed}.git` ? repo.url : a)),
              });
            },
          }),
        );
        yield* s.inspect('mcp');
        const result = yield* s.watchSources(
          decodeOperationInput('watchSources', { sourceIds: [sourceIdentity(url), mixed, sourceIdentity(ssh)] }),
        );
        assert.equal(result.state, 'complete');
        assert.deepEqual(
          result.items.map((r) => r.sourceId),
          [sourceIdentity(url), mixed, sourceIdentity(ssh)],
        );
        assert.ok(!JSON.stringify(result).includes(url));assert.ok(!JSON.stringify(result).includes(ssh));
        const before = calls;
        yield* Effect.flip(
          s.watchSources(decodeOperationInput('watchSources', { sourceIds: [sourceIdentity(local)] })),
        );
        yield* Effect.flip(s.watchSources(decodeOperationInput('watchSources', { sourceIds: ['../../private'] })));
        assert.equal(calls, before);
      }),
    ),
    fixture.source,
  );
});

test('trusted configured file checkout uses an opaque ID and read-only draft without private paths', async (t) => {
  const m = agentMachine();
  t.after(() => rmSync(m.root, { recursive: true, force: true }));
  await m.trust();
  await m.run(DecisionsStore.use((store) => store.record(accept(EFFORT))));
  const from = commitFiles(m.paths.repo, 'baseline', { 'skills/one/SKILL.md': 'old', 'skills-manifest.txt': '# author manifest\n', 'skill-pins.json': '{"version":1,"pins":{}}\n', 'source-ignores.json': '{}\n' }),
    to = commitFiles(m.paths.repo, 'changed', { 'skills/one/SKILL.md': 'new' });
  const branch=gitSync(m.paths.repo,'symbolic-ref','--short','HEAD');
  gitSync(m.paths.repo,'update-ref',`refs/remotes/origin/${branch}`,from);
  gitSync(m.paths.repo,'branch',`--set-upstream-to=origin/${branch}`);
  m.write(join(m.paths.repo,'skills/one/SKILL.md'),'dirty\n'+'Z'.repeat(40000));
  m.write(join(m.paths.repo,'skills/untracked/SKILL.md'),'untracked skill\n');
  const index=readFileSync(join(m.paths.repo,'.git/index'));
  const documents=['skills-manifest.txt','skill-pins.json','source-ignores.json'].map(p=>[p,m.read(join(m.paths.repo,p))]);
  const source = pathToFileURL(m.paths.repo).href,
    id = sourceIdentity(source);
  const fixture = setupFixture(join(m.root, 'setup'), { headFiles: { 'skills-manifest.txt': `[${source}]\none\n[example/setup]\none\n` } });
  await m.run(
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* startAgent(() => m.domains, { deferStart: true });
        const processes=yield* Processes;
        const s = yield* makeSession(h, { domains: () => m.domains, signal: new AbortController().signal }).pipe(
          Effect.provide(
            sourceEnvironment({
              PATH: process.env.PATH!,
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_ALLOW_PROTOCOL: 'file',
            }),
          ),
          Effect.provideService(Processes,{run:c=>c.cmd==='git' ? processes.run({...c,args:c.args.map(a=>a==='https://github.com/example/setup.git'?source:a)}) : Effect.die(new Error('Unfaked command'))}),
        );
        yield* s.inspect('mcp');
        const page = yield* s.watchSources(decodeOperationInput('watchSources', { limit: 1 }));
        assert.ok(page.nextCursor);
        const watched = yield* s.watchSources(decodeOperationInput('watchSources', {}));
        assert.equal(watched.items[0]?.sourceId, id);
        assert.equal(watched.items[0]?.toRevision, to);
        assert.ok(watched.items.find(r=>r.sourceId==='example/setup')?.local);
        const local=watched.items[0]?.local; assert.ok(local);
        assert.equal(local.status,'edits');assert.equal(local.branch,branch);assert.deepEqual(local.unpushed.map(c=>c.sha),[to]);
        assert.deepEqual(local.skills.map(s=>s.name),['one','untracked']);
        assert.ok(local.uncommitted.includes('skills/untracked/SKILL.md'));
        const selection={sourceId:id,localObservation:local.observation,skillId:`skill:${id}/one`};
        const part=yield* s.inspectSourceDiff(decodeOperationInput('inspectSourceDiff',selection));
        assert.equal(part.state,'limited');assert.ok(part.nextCursor);
        const rest=yield* s.inspectSourceDiff(decodeOperationInput('inspectSourceDiff',{...selection,cursor:part.nextCursor!}));
        assert.match(part.text+rest.text,/dirty/);assert.ok((part.text+rest.text).includes('Z'.repeat(40000)));
        const untracked=yield* s.inspectSourceDiff(decodeOperationInput('inspectSourceDiff',{...selection,skillId:`skill:${id}/untracked`}));assert.match(untracked.text,/untracked skill/);
        assert.deepEqual(readFileSync(join(m.paths.repo,'.git/index')),index);
        assert.equal(m.read(join(m.paths.repo,'skills/one/SKILL.md')),'dirty\n'+'Z'.repeat(40000));
        m.write(join(m.paths.repo,'skills/untracked/SKILL.md'),'changed observation');
        yield* s.watchSources(decodeOperationInput('watchSources', {sourceIds:[id]}));
        assert.equal((yield* Effect.flip(s.watchSources(decodeOperationInput('watchSources',{cursor:page.nextCursor!})))).code,'UNKNOWN_PLAN');
        assert.equal((yield* Effect.flip(s.inspectSourceDiff(decodeOperationInput('inspectSourceDiff',{...selection,cursor:part.nextCursor!})))).code,'UNKNOWN_PLAN');
        assert.ok(!JSON.stringify(watched).includes(m.root));
        const draft = yield* s.draftChangelog(
          decodeOperationInput('draftChangelog', { accepted: [{ sourceId: id, fromRevision: from, toRevision: to }] }),
        );
        assert.match(draft.text, /Updated `one`/);
        assert.ok(!draft.text.includes(m.root));
        assert.ok(draft.text.includes(id));
        assert.deepEqual(readFileSync(join(m.paths.repo,'.git/index')),index);
        for(const [p,bytes] of documents) assert.equal(m.read(join(m.paths.repo,p!)),bytes);
        assert.equal(gitSync(m.paths.repo, 'rev-parse', 'HEAD'), to);
        assert.match(gitSync(m.paths.repo, 'status', '--porcelain'), /skills\/one\/SKILL.md/);
        yield* Effect.flip(s.watchSources(decodeOperationInput('watchSources', { sourceIds: [source] })));
      }),
    ),
    fixture.source,
  );
});

test('sourceDecision has an exact SHA contract and rejects arbitrary author destinations', () => {
  for (const action of ['pin','ignore']) {
    assert.equal(decodeOperationInput('previewChange',{change:{kind:'sourceDecision',sourceId:'Owner/Repo',action,revision:'a'.repeat(40)}}).change.kind,'sourceDecision');
    for (const revision of [undefined,'HEAD','A'.repeat(40),'a'.repeat(64)])
      assert.throws(()=>decodeOperationInput('previewChange',{change:{kind:'sourceDecision',sourceId:'Owner/Repo',action,revision}}));
  }
  for (const action of ['unpin','unignore']) {
    decodeOperationInput('previewChange',{change:{kind:'sourceDecision',sourceId:'Owner/Repo',action}});
    assert.throws(()=>decodeOperationInput('previewChange',{change:{kind:'sourceDecision',sourceId:'Owner/Repo',action,revision:'a'.repeat(40)}}));
  }
  assert.throws(()=>decodeOperationInput('previewChange',{change:{kind:'sourceDecision',sourceId:'Owner/Repo',action:'unpin',path:'/private'}}));
});

import { Fs, FsFailed, HistoryStore, OverridesStore } from '@nortuscc/machine';
import { SetupSource, type AgentSession } from '../src/index.ts';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import { operationDigest } from '../src/runs.ts';
import { RunStore } from '../src/run-store.ts';
const sourceDecisionFixture = async (t: import('node:test').TestContext, authorDeclaration = true, sourceKeyInput = 'owner/repo') => {
  const m = agentMachine(); t.after(() => rmSync(m.root,{recursive:true,force:true}));
  const sourceKey=sourceKeyInput==='configured-file'?pathToFileURL(m.paths.repo).href:sourceKeyInput;
  const repo = makeRepo(m.root);
  const from=repo.commit('old',{'skills/one/SKILL.md':'old','skills/added/SKILL.md':'same'}), to=repo.commit('new',{'skills/one/SKILL.md':'new'});
  const original = '{\r\n  "version": 1,\r\n  "pins": '+JSON.stringify(sourceKeyInput==='configured-file'?{}:{[sourceKey]:from})+'\r\n}\r\n';
  const manifest='['+sourceKey+']\none\n';
  commitFiles(m.paths.repo,'author',{'skills-manifest.txt':authorDeclaration?manifest:'# no author source\n','skill-pins.json':authorDeclaration?JSON.stringify({version:1,pins:sourceKeyInput==='configured-file'?{}:{[sourceKey]:from}}):'{"version":1,"pins":{}}','source-ignores.json':'{"version":1,"ignored":{},"note":"keep"}\n'});
  if(authorDeclaration)m.write(join(m.paths.repo,'skill-pins.json'),original);
  m.write(join(m.paths.stateRoot,'overrides.json'),JSON.stringify({version:2,skillAdditions:[{source:'owner/repo',name:'added',targets:['codex']}]}));
  const f=setupFixture(join(m.root,'setup'),{headFiles:{'skills-manifest.txt':manifest,'skill-pins.json':JSON.stringify({version:1,pins:sourceKeyInput==='configured-file'?{}:{[sourceKey]:from}})}});
  const compose=<T extends {repo:string}>(snapshot:T)=>Effect.gen(function*(){const overrides=yield* Effect.promise(()=>m.run(OverridesStore.use(store=>store.read)));return {...snapshot,desired:yield* loadProfile(snapshot.repo,{overrides}).pipe(Effect.provide(nodeFiles))};}).pipe(Effect.orDie);
  const source=Layer.succeed(SetupSource,{...f.service,current:f.service.current.pipe(Effect.flatMap(compose)),load:revision=>f.service.load(revision).pipe(Effect.flatMap(compose)),effective:decisions=>f.service.effective(decisions).pipe(Effect.flatMap(v=>Effect.gen(function*(){return {...v,applied:yield* compose(v.applied),effective:yield* compose(v.effective)};})))});
  await m.trust();await m.run(DecisionsStore.use(store=>store.record(accept(EFFORT))));
  let fault:'write'|'checkpoint'|'sourceAfterBackup'|undefined, writes=0;
  const within=<A,E>(body:(s:AgentSession)=>Effect.Effect<A,E>)=>m.run(Effect.scoped(Effect.gen(function*(){
    const fs=yield* Fs, processes=yield* Processes, history=yield* HistoryStore;
    let checkpointFailed=false;
    const h=yield* startAgent(()=>m.domains,{deferStart:true});
    const s=yield* makeSession(h,{domains:()=>m.domains,signal:new AbortController().signal}).pipe(
      Effect.provide(sourceEnvironment({PATH:process.env.PATH!,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ALLOW_PROTOCOL:'file'})),
      Effect.provideService(Processes,{run:c=> {
        if(c.cmd!=='git')return Effect.die(new Error('Unfaked source decision command'));
        const args=c.args.map(a=>a===(sourceKey.includes('://')?sourceKey:`https://github.com/${sourceKey}.git`)?(sourceKeyInput==='configured-file'?sourceKey:repo.url):a);
        const roots=[resolve(m.root),realpathSync(m.root)],inside=(path:string)=>roots.some(root=>resolve(path)===root||resolve(path).startsWith(root+sep));
        const at=args.indexOf('-C'),directory=c.cwd??(at>=0?args[at+1]:args.includes('clone')?args.at(-1):undefined);
        if(!directory||!inside(directory)||args.some(a=>a.startsWith('file:')&&!inside(new URL(a).pathname)))return Effect.die(new Error('Non-fixture Git refused'));
        if(args.some(a=>/^(?:https?:|ssh:|git@)/.test(a)))return Effect.die(new Error('Unrouted remote'));
        return processes.run({...c,args});
      }}),
      Effect.provideService(HistoryStore,{...history,append:event=>fault==='checkpoint' && !checkpointFailed && event.kind==='operation-checkpoint' && event.committedKeys?.some(key=>key.startsWith('source:')) ? Effect.suspend(()=>{checkpointFailed=true;return Effect.fail(new FsFailed({op:'history',path:'PRIVATE',reason:'PRIVATE'}));}) : history.append(event)}),
      Effect.provideService(Fs,{...fs,copy:(from,to,options)=>fs.copy(from,to,options).pipe(Effect.tap(()=>fault==='sourceAfterBackup' && to.endsWith('/author/skill-pins.json') ? Effect.sync(()=>{repo.commit('source moved during backup',{'skills/one/SKILL.md':'moved'});}) : Effect.void)),writeTextAtomic:(path,text)=>{
        if(path.endsWith('/skill-pins.json')||path.endsWith('/source-ignores.json')) {
          writes++;if(fault==='write')return Effect.fail(new FsFailed({op:'write',path:'PRIVATE',reason:'PRIVATE token=secret'}));
        }
        return fs.writeTextAtomic(path,text);
      }}),
    );
    yield* s.inspect('mcp');return yield* body(s);
  })),source);
  return {m,repo,from,to,original,within,sourceKey,get writes(){return writes;},fault:(value:typeof fault)=>{fault=value;}};
};
const submitSource=(s:AgentSession,planId:string,requestId:string)=>Effect.gen(function*(){
  const request={planId,requestId,inputDigest:operationDigest(planId),actor:'mcp' as const};
  const accepted=yield* s.runs.submit(request);
  yield* Effect.callback<void>(resume=>{const off=s.runs.subscribe(accepted.runId,run=>{if(run.result)resume(Effect.void);});return Effect.sync(off);});
  while(yield* s.running)yield* Effect.yieldNow;
  return {run:yield* s.runs.get(accepted.runId),request};
});
test('source author decisions preview all source skills, preserve machine policy/snapshot/index and retry without replay',async t=>{
  const f=await sourceDecisionFixture(t), beforeOverrides=f.m.read(join(f.m.paths.stateRoot,'overrides.json')), index=readFileSync(join(f.m.paths.repo,'.git/index'));
  let accepted:Parameters<AgentSession['runs']['submit']>[0]|undefined,runId='';
  await f.within(s=>Effect.gen(function*(){
    for(const action of ['pin','unpin','ignore','unignore'] as const) {
      const change=action==='pin'||action==='ignore'?{kind:'sourceDecision' as const,sourceId:'owner/repo',action,revision:f.to}:{kind:'sourceDecision' as const,sourceId:'owner/repo',action};
      const p=yield* s.previewChange(change);assert.equal(p.change.kind,'sourceDecision');
      if(!('sourceDecision' in p))throw new Error('Missing source preview');
      assert.deepEqual(p.sourceDecision.machinePolicy.map(s=>s.skillId),['skill:owner/repo/one','skill:owner/repo/added']);
      if(action==='pin')assert.deepEqual(p.sourceDecision.impact.map(s=>s.skillId),['skill:owner/repo/one','skill:owner/repo/added']);
      assert.equal(p.sourceDecision.checkout,f.m.paths.repo);assert.ok(!JSON.stringify(p).includes('note'));
      const {run,request}=yield* submitSource(s,p.planId,'source-'+action);assert.equal(run.state,'succeeded');assert.equal(run.parity?.kind,'sourceDecision');assert.equal(run.parity?.state,'committed');
      const writes=f.writes;assert.equal((yield* s.runs.submit(request)).runId,run.runId);assert.equal(f.writes,writes);
      if(action==='pin'){accepted=request;runId=run.runId;const backup=run.parity!.backupIds[0]!;assert.equal(f.m.read(join(f.m.paths.backups,backup,'author/skill-pins.json')),f.original);}
      yield* s.inspect('mcp');
    }
  }));
  await f.m.run(RunStore.use(store=>Effect.gen(function*(){const receipt=(yield* store.read).find(r=>r.view.runId===runId)!;yield* store.write({...receipt,view:{...receipt.view,state:'running',result:null}});})));
  const writes=f.writes;await f.within(s=>Effect.gen(function*(){assert.equal((yield* s.runs.submit(accepted!)).runId,runId);const recovered=yield* s.runs.get(runId);assert.equal(recovered.state,'interrupted');assert.equal(recovered.parity?.state,'needsInspection');assert.equal(recovered.parity?.committedKeys.length,1);assert.equal(recovered.parity?.backupIds.length,1);}));assert.equal(f.writes,writes);
  assert.equal(f.m.read(join(f.m.paths.stateRoot,'overrides.json')),beforeOverrides);assert.deepEqual(readFileSync(join(f.m.paths.repo,'.git/index')),index);
  assert.equal(JSON.parse(f.m.read(join(f.m.paths.repo,'source-ignores.json'))!).note,'keep');
  assert.equal(JSON.parse(f.m.read(join(f.m.root,'setup/head/skill-pins.json'))!).pins['owner/repo'],f.from);
});
test('source decisions refuse missing author declarations and stale watched SHA, dirty document, HEAD or index',async t=>{
  const missing=await sourceDecisionFixture(t,false);
  await missing.within(s=>Effect.gen(function*(){const e=yield* Effect.flip(s.previewChange({kind:'sourceDecision',sourceId:'owner/repo',action:'pin',revision:missing.to}));assert.match(e.message,/author.*declaration|declaration.*author/);assert.equal(missing.writes,0);}));
  for(const mutation of ['source','document','head','index'] as const) {
    const f=await sourceDecisionFixture(t);
    await f.within(s=>Effect.gen(function*(){
      const p=yield* s.previewChange({kind:'sourceDecision',sourceId:'owner/repo',action:'ignore',revision:f.to});
      if(mutation==='source')f.repo.commit('moving',{'skills/one/SKILL.md':'moved'});
      if(mutation==='document')f.m.write(join(f.m.paths.repo,'source-ignores.json'),'{"version":1,"ignored":{}}\n ');
      if(mutation==='head')commitFiles(f.m.paths.repo,'new head');
      if(mutation==='index')gitSync(f.m.paths.repo,'update-index','--chmod=+x','source-ignores.json');
      const e=yield* Effect.flip(s.runs.submit({planId:p.planId,requestId:'stale-'+mutation,inputDigest:operationDigest(p.planId),actor:'mcp'}));
      assert.equal(e.code,'UNKNOWN_PLAN');assert.equal(f.writes,0);
    }));
  }
});
test('source write failure and failed post-replacement checkpoint retain backups and observed commits on retry/restart',async t=>{
  for(const fault of ['write','checkpoint'] as const) {
    const f=await sourceDecisionFixture(t);f.fault(fault);
    let request:Parameters<AgentSession['runs']['submit']>[0]|undefined,id='';
    await f.within(s=>Effect.gen(function*(){
      const p=yield* s.previewChange({kind:'sourceDecision',sourceId:'owner/repo',action:'pin',revision:f.to});
      const submitted=yield* submitSource(s,p.planId,'partial-'+fault);request=submitted.request;id=submitted.run.runId;
      assert.equal(submitted.run.state,'failed');assert.equal(submitted.run.parity?.state,'needsInspection');assert.equal(submitted.run.parity?.backupIds.length,1);
      assert.equal(submitted.run.parity?.committedKeys.length,fault==='checkpoint'?1:0);
      assert.equal(JSON.parse(f.m.read(join(f.m.paths.repo,'skill-pins.json'))!).pins['owner/repo'],fault==='checkpoint'?f.to:f.from);
      assert.doesNotMatch(JSON.stringify(submitted.run),/PRIVATE|secret/);
    }));
    const writes=f.writes;f.fault(undefined);
    await f.within(s=>Effect.gen(function*(){const retried=yield* s.runs.submit(request!);assert.equal(retried.runId,id);assert.equal((yield* s.runs.get(id)).state,'failed');}));
    assert.equal(f.writes,writes);
  }
});

test('known non-GitHub and configured file source decisions retain original author document keys',async t=>{
  for(const declaration of ['https://gitlab.com/Owner/Repo.git','configured-file']) {
    const f=await sourceDecisionFixture(t,true,declaration), id=sourceIdentity(f.sourceKey);
    const target=declaration==='configured-file'?gitSync(f.m.paths.repo,'rev-parse','HEAD'):f.to;
    await f.within(s=>Effect.gen(function*(){
      const p=yield* s.previewChange({kind:'sourceDecision',sourceId:id,action:'pin',revision:target});
      const {run}=yield* submitSource(s,p.planId,'original-key');assert.equal(run.state,'succeeded');
      const pins=JSON.parse(f.m.read(join(f.m.paths.repo,'skill-pins.json'))!).pins;
      assert.equal(pins[f.sourceKey],target);assert.equal(pins[id],undefined);assert.ok(!JSON.stringify(p).includes('gitlab.com'));
    }));
  }
});

test('pinImpact and source preview include machine additions under normalized source policy without merging document keys',async t=>{
  const f=await sourceDecisionFixture(t,true,'Owner/Repo');
  await f.within(s=>Effect.gen(function*(){
    const impact=yield* s.pinImpact(decodeOperationInput('pinImpact',{sourceId:'Owner/Repo',revision:f.to}));
    assert.deepEqual(impact.skills.map(skill=>skill.name),['one','added']);assert.deepEqual(impact.skills.map(skill=>skill.skillId),['skill:Owner/Repo/one','skill:owner/repo/added']);
    const p=yield* s.previewChange({kind:'sourceDecision',sourceId:'Owner/Repo',action:'pin',revision:f.to});
    if(!('sourceDecision' in p))throw new Error('Missing source preview');
    assert.deepEqual(p.sourceDecision.impact.map(skill=>skill.skillId),['skill:Owner/Repo/one','skill:owner/repo/added']);const {run}=yield* submitSource(s,p.planId,'normalized-impact');assert.equal(run.state,'succeeded');
    const pins=JSON.parse(f.m.read(join(f.m.paths.repo,'skill-pins.json'))!).pins;assert.equal(pins['Owner/Repo'],f.to);assert.equal(pins['owner/repo'],undefined);
  }));
});

test('a source moving after backup fails before replacement with durable backup evidence',async t=>{
  const f=await sourceDecisionFixture(t);
  await f.within(s=>Effect.gen(function*(){
    const p=yield* s.previewChange({kind:'sourceDecision',sourceId:'owner/repo',action:'pin',revision:f.to});f.fault('sourceAfterBackup');
    const {run}=yield* submitSource(s,p.planId,'source-after-backup');assert.equal(run.state,'failed');assert.equal(run.parity?.state,'needsInspection');assert.equal(run.parity?.backupIds.length,1);assert.deepEqual(run.parity?.committedKeys,[]);assert.equal(f.writes,0);
    assert.equal(f.m.read(join(f.m.paths.repo,'skill-pins.json')),f.original);
    assert.equal(f.m.read(join(f.m.paths.backups,run.parity!.backupIds[0]!,'author/skill-pins.json')),f.original);
  }));
});
