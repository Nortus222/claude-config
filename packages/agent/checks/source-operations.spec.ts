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
import { join } from 'node:path';
import { rmSync, readFileSync, readdirSync } from 'node:fs';
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
