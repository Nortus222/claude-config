import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { Backups, backupsForRun, machinePaths, nodeFs } from '../src/index.ts';

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-backups-'));
  const paths = {
    repo: home, claude: join(home, '.claude'), codex: join(home, '.codex'), codexOpenRouter: join(home, '.codex-openrouter'),
    agentsSkills: join(home, 'skills'), stateRoot: join(home, 'state'), backups: join(home, 'state', 'backups'),
  };
  const layer = backupsForRun(new Date('2026-10-05T12:34:56.789Z')).pipe(Layer.provide(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const run = <A, E>(f: (b: Backups['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromise(Backups.use(f).pipe(Effect.provide(layer)));
  return { home, paths, run };
};

test('nothing to back up creates no folder', async () => {
  const { home, paths, run } = setup();
  const result = await run((b) => Effect.all([b.moveAside(join(home, 'absent'), 'absent', 'claude'), b.dir]));
  assert.deepEqual(result, [undefined, undefined]);
  assert.equal(existsSync(paths.backups), false);
});

test('moveAside and preserve use the legacy layout', async () => {
  const { home, paths, run } = setup();
  writeFileSync(join(home, 'CLAUDE.md'), 'mine');
  writeFileSync(join(home, 'settings.json'), '{}');
  const [moved, kept, dir] = await run((b) => Effect.all([
    b.moveAside(join(home, 'CLAUDE.md'), 'CLAUDE.md', 'claude'),
    b.preserve(join(home, 'settings.json'), 'settings.json', 'claude'),
    b.dir,
  ]));
  const folder = join(paths.backups, 'nortuscc-2026-10-05T12-34-56-789Z');
  assert.equal(dir, folder);
  assert.equal(moved, join(folder, 'claude', 'CLAUDE.md'));
  assert.equal(readFileSync(moved!, 'utf8'), 'mine');
  assert.equal(existsSync(join(home, 'CLAUDE.md')), false);
  assert.equal(kept, join(folder, 'claude', 'settings.json'));
  assert.equal(existsSync(join(home, 'settings.json')), true);
});

test('a repeat preserve keeps the first copy and leaves the live file alone', async () => {
  const { home, run } = setup();
  const live = join(home, 'settings.json');
  writeFileSync(live, 'original');
  const [first, second] = await run((b) => Effect.gen(function* () {
    const first = yield* b.preserve(live, 'settings.json', 'claude');
    writeFileSync(live, 'written by this run');
    return [first, yield* b.preserve(live, 'settings.json', 'claude')];
  }));
  assert.equal(second, first);
  assert.equal(readFileSync(first!, 'utf8'), 'original');
  assert.equal(readFileSync(live, 'utf8'), 'written by this run');
});

test('a repeat moveAside vacates the live path without overwriting the first backup', async () => {
  const { home, run } = setup();
  const live = join(home, 'CLAUDE.md');
  writeFileSync(live, 'original');
  const [first, second] = await run((b) => Effect.gen(function* () {
    const first = yield* b.moveAside(live, 'CLAUDE.md', 'claude');
    writeFileSync(live, 'written by this run');
    return [first, yield* b.moveAside(live, 'CLAUDE.md', 'claude')];
  }));
  assert.equal(second, first);
  assert.equal(readFileSync(first!, 'utf8'), 'original');
  assert.equal(existsSync(live), false);
});

test('a path absent at its first call is never backed up later in the run', async () => {
  const { home, paths, run } = setup();
  const live = join(home, 'CLAUDE.md');
  const results = await run((b) => Effect.gen(function* () {
    const first = yield* b.moveAside(live, 'CLAUDE.md', 'claude');
    writeFileSync(live, 'written by this run');
    const moved = yield* b.moveAside(live, 'CLAUDE.md', 'claude');
    writeFileSync(live, 'written again');
    const kept = yield* b.preserve(live, 'CLAUDE.md', 'claude');
    return [first, moved, kept, yield* b.dir];
  }));
  assert.deepEqual(results, [undefined, undefined, undefined, undefined]);
  assert.equal(readFileSync(live, 'utf8'), 'written again');
  assert.equal(existsSync(paths.backups), false);
});
