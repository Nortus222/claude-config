import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect, Layer } from 'effect';
import { Processes, type Command } from '@nortuscc/machine';
import * as owner from '../src/index.ts';
test('machine Git injects explicit environment, bounded capture and safe failures', async () => {
  assert.equal(typeof owner.machineGit, 'function');
  let command: Command | undefined;
  const processes = Layer.succeed(Processes, {
    run: (c) => {
      command = c;
      return Effect.succeed({ code: 0, stdout: 'ok' });
    },
  });
  const git = owner.machineGit({
    env: {
      PATH: '/bin',
      GIT_DIR: '/private',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: 'test',
    },
    timeoutMs: 15000,
    maxBytes: 1048576,
  });
  assert.equal(
    await Effect.runPromise(
      owner.Git.use((g) => g.run(['status'])).pipe(Effect.provide(git.pipe(Layer.provide(processes)))),
    ),
    'ok',
  );
  assert.deepEqual(command?.envAllow, []);
  assert.equal(command?.env?.GIT_DIR, undefined);
  assert.equal(command?.env?.GIT_TERMINAL_PROMPT, '0');
  assert.equal(command?.env?.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(command?.env?.GIT_CONFIG_VALUE_0, 'test');
  assert.deepEqual(command?.captureLimit, { stdout: 1032192, stderr: 16384 });
});

import { Cause, Exit } from 'effect';
import { Fs, nodeFs, nodeProcesses } from '@nortuscc/machine';
import { join } from 'node:path';
import { makeRepo, tempDir } from './fixtures.ts';
test('injected Fs watch and pin impact preserve source-wide algorithms and option-ref refusal', async (t) => {
  const root = tempDir(t),
    repo = makeRepo(root);
  const from = repo.commit('first', { 'skills/one/SKILL.md': 'old', 'skills/two/SKILL.md': 'same' });
  const to = repo.commit('second', { 'skills/one/SKILL.md': 'new', 'skills/added/SKILL.md': 'added' });
  const source = { source: 'owner/repo', url: repo.url, baseline: from, skills: ['one', 'two'], exact: false };
  const layer = owner
    .machineGit({
      env: {
        PATH: process.env.PATH!,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ALLOW_PROTOCOL: 'file',
      },
      timeoutMs: 15000,
      maxBytes: 1048576,
    })
    .pipe(Layer.provide(nodeProcesses({ env: {} })));
  const run = <A, E>(effect: Effect.Effect<A, E, owner.Git | Fs>) =>
    Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(layer, nodeFs))));
  const report = await run(owner.watchUpstreamWithServices(source, { cacheDir: join(root, 'cache') }));
  assert.equal(report.latest?.sha, to);
  assert.equal(report.baseline?.sha, from);
  assert.deepEqual(report.added, ['added']);
  const impact = await run(owner.pinImpactWithServices(source, to, { cacheDir: join(root, 'cache') }));
  assert.deepEqual(impact.skills, [
    { name: 'one', status: 'changed' },
    { name: 'two', status: 'unchanged' },
  ]);
  assert.equal(impact.to.sha, to);
  await assert.rejects(
    run(owner.pinImpactWithServices(source, '--upload-pack=bad', { cacheDir: join(root, 'cache') })),
  );
  assert.equal(
    repo.commit('still writable'),
    (await run(owner.watchUpstreamWithServices(source, { cacheDir: join(root, 'cache') }))).latest?.sha,
  );
});
test('Git output and failures are bounded without stderr reflection', async () => {
  for (const result of [
    { code: 1, stdout: '', stderr: 'token=private /private/home' },
    { code: 0, stdout: 'x'.repeat(17), stderr: '' },
  ]) {
    const layer = owner
      .machineGit({ env: {}, timeoutMs: 100, maxBytes: 16 })
      .pipe(Layer.provide(Layer.succeed(Processes, { run: () => Effect.succeed(result) })));
    const error = await Effect.runPromise(
      Effect.flip(owner.Git.use((g) => g.run(['status']))).pipe(Effect.provide(layer)),
    );
    assert.equal(error.reason, 'Source Git read unavailable');
    assert.doesNotMatch(JSON.stringify(error), /private/);
  }
});
test('process deadline joins finalizers and retains mixed cleanup defects', async () => {
  let joined = false;
  const layer = owner.machineGit({ env: {}, timeoutMs: 5, maxBytes: 16 }).pipe(
    Layer.provide(
      Layer.succeed(Processes, {
        run: (command) =>
          Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                joined = true;
                command.onCleanup?.({ joined: false });
              }),
            ),
          ),
      }),
    ),
  );
  const exit = await Effect.runPromise(
    Effect.exit(owner.Git.use((g) => g.run(['fetch'], { cwd: '/cache/known' }))).pipe(Effect.provide(layer)),
  );
  assert.equal(joined, true);
  assert.ok(Exit.isFailure(exit));
  assert.ok(exit.cause.reasons.some((r) => Cause.isDieReason(r) && r.defect instanceof owner.SourceCleanupFailed));
  const mixed = await Effect.runPromise(
    Effect.exit(
      owner.joinedDeadline(
        Effect.never.pipe(
          Effect.ensuring(Effect.die(new owner.SourceCleanupFailed({ retainedDirectory: '/cache/known' }))),
        ),
        5,
      ),
    ),
  );
  assert.ok(Exit.isFailure(mixed));
  assert.ok(mixed.cause.reasons.some(Cause.isDieReason));
});

import { guardedCacheRead } from '../src/services.ts';
import { FsFailed } from '@nortuscc/machine';
test('cache ownership precedes readers; failure to establish it starts no reader and uncertainty survives restart', async (t) => {
  const root = tempDir(t),
    dir = join(root, 'cache', 'known'),
    marker = `${dir}.cleanup-uncertain`;
  let started = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* Fs;
      const body = Effect.gen(function* () {
        started++;
        assert.equal(yield* fs.exists(marker), true);
        return 'read';
      });
      const rejected = yield* Effect.exit(
        guardedCacheRead(dir, body).pipe(
          Effect.provideService(Fs, {
            ...fs,
            createDirectory: (path, options) => path === marker
              ? Effect.fail(new FsFailed({ op: 'mkdir', path: marker, reason: 'fixture unavailable' }))
              : fs.createDirectory(path, options),
          }),
        ),
      );
      assert.ok(Exit.isFailure(rejected));
      assert.equal(started, 0);
      assert.equal(yield* guardedCacheRead(dir, body), 'read');
      assert.equal(yield* fs.exists(marker), false);
      yield* Effect.exit(guardedCacheRead(dir, Effect.die(new owner.SourceCleanupFailed({ retainedDirectory: dir }))));
      assert.equal(yield* fs.exists(marker), true);
    }).pipe(Effect.provide(nodeFs)),
  );
  // A fresh service context has no in-memory observation of the prior process.
  const restarted = await Effect.runPromise(
    Effect.exit(
      guardedCacheRead(
        dir,
        Effect.sync(() => {
          started++;
        }),
      ),
    ).pipe(Effect.provide(nodeFs)),
  );
  assert.ok(Exit.isFailure(restarted));
  assert.equal(started, 1);
});

test('real process owner enforces Git capture overflow and joins a timed-out Git alias', async (t) => {
  const root = tempDir(t),
    repo = makeRepo(root);
  repo.commit('large', { 'large.txt': 'x'.repeat(8192) });
  const layer = owner
    .machineGit({
      env: { PATH: process.env.PATH!, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      timeoutMs: 25,
      maxBytes: 1024,
    })
    .pipe(Layer.provide(nodeProcesses({ env: {} })));
  for (const args of [
    ['show', 'HEAD:large.txt'],
    ['-c', 'alias.wait=!sleep 5', 'wait'],
  ]) {
    const result = await Effect.runPromise(
      Effect.flip(owner.Git.use((g) => g.run(args, { cwd: repo.dir }))).pipe(Effect.provide(layer)),
    );
    assert.equal(result.reason, 'Source Git read unavailable');
  }
});

import { Deferred } from 'effect';
test('cache claims are exclusive even when concurrent existence checks both report absence', async (t) => {
  const root = tempDir(t),
    dir = join(root, 'cache', 'same');
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* Fs;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let readers = 0;
        const shared = {
          ...fs,
          stat: (path: string) => (path.endsWith('.cleanup-uncertain') ? Effect.succeed(undefined) : fs.stat(path)),
        };
        const first = yield* Effect.forkChild(
          guardedCacheRead(
            dir,
            Effect.gen(function* () {
              readers++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
          ).pipe(Effect.provideService(Fs, shared)),
        );
        yield* Deferred.await(entered);
        const second = yield* Effect.exit(
          guardedCacheRead(
            dir,
            Effect.sync(() => {
              readers++;
            }),
          ).pipe(Effect.provideService(Fs, shared)),
        );
        assert.ok(Exit.isFailure(second));
        assert.equal(readers, 1);
        yield* Deferred.succeed(release, undefined);
      }),
    ).pipe(Effect.provide(nodeFs)),
  );
});

import { mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
test('cache containment refuses redirected sentinel, root, cache and marker without touching outside bytes', async t => {
  const root=tempDir(t), outside=join(root,'outside'); mkdirSync(outside);
  const document=join(outside,'author.txt'); writeFileSync(document,'preserve me\n');
  for(const target of ['sentinel','root','cache','marker']) {
    const parent=join(root,target),dir=join(parent,'known');
    if(target==='root') symlinkSync(outside,parent); else mkdirSync(parent);
    if(target==='sentinel') symlinkSync(document,join(parent,'.source-cache'));
    if(target==='cache') symlinkSync(outside,dir);
    if(target==='marker') symlinkSync(outside,`${dir}.cleanup-uncertain`);
    let started=0;
    const result=await Effect.runPromise(Effect.exit(guardedCacheRead(dir,Effect.sync(()=>{started++;}))).pipe(Effect.provide(nodeFs)));
    assert.ok(Exit.isFailure(result),target); assert.equal(started,0,target);
    assert.equal(readFileSync(document,'utf8'),'preserve me\n');
    assert.equal(existsSync(join(outside,'known.cleanup-uncertain')),false);
  }
});

test('a failed joined marker removal retains the exclusive claim for the next reader', async t => {
  const root = tempDir(t), directory = join(root, 'cache', 'known');
  let readers = 0;
  await Effect.runPromise(Effect.gen(function* () {
    const fs = yield* Fs;
    const read = guardedCacheRead(directory, Effect.sync(() => { readers++; }));
    const failed = yield* Effect.exit(read.pipe(Effect.provideService(Fs, {
      ...fs, remove: path => Effect.fail(new FsFailed({ op: 'remove', path, reason: 'fixture' })),
    })));
    assert.ok(Exit.isFailure(failed));
    assert.equal(yield* fs.exists(`${directory}.cleanup-uncertain`), true);
    assert.ok(Exit.isFailure(yield* Effect.exit(read)));
    assert.equal(readers, 1);
  }).pipe(Effect.provide(nodeFs)));
});
