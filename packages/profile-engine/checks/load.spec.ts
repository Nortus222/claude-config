import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import {
  ProfileFiles, ReadFailed, decodeOverrides, loadProfile, memoryFiles, nodeFiles, requireValid,
} from '../src/index.ts';

const PIN = '0123456789abcdef0123456789abcdef01234567';
const hookDoc = JSON.stringify({
  version: 1,
  integrations: [{ id: 'h', label: 'h', target: 'claude', type: 'hook', default: true, event: 'Stop', file: 'hooks/h.sh' }],
});
const repo = {
  '/repo/skills-manifest.txt': '[a/core]\ntdd\n',
  '/repo/integrations.json': hookDoc,
  '/repo/hooks/h.sh': '#!/bin/sh\n',
  '/repo/claude/settings.keys.json': '{"effortLevel":"high"}',
  '/repo/skill-pins.json': JSON.stringify({ version: 1, pins: { 'a/core': PIN } }),
};
const run = <A, E>(effect: Effect.Effect<A, E, ProfileFiles>, layer = memoryFiles(repo)) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

test('loads every layer from the repo directory', async () => {
  const config = await run(loadProfile('/repo', { overrides: decodeOverrides({ version: 1, skills: { tdd: false } }, 'o.json') }));
  assert.deepEqual(config.issues, []);
  assert.deepEqual(config.skills.map((s) => [s.name, s.install, s.from.layer, s.pin?.ref]), [['tdd', false, 'machine', PIN]]);
  assert.deepEqual(config.integrations.map((i) => i.id), ['h']);
  assert.equal(config.files.find((f) => f.id === 'claude:settings.json')!.keys!.effortLevel!.value, 'high');
});

test('a hook file missing from the repo refuses the integrations document', async () => {
  const { '/repo/hooks/h.sh': _hook, ...withoutHook } = repo;
  const config = await run(loadProfile('/repo'), memoryFiles(withoutHook));
  assert.deepEqual(config.integrations, []);
  assert.match(config.issues[0]!.message, /referenced file 'hooks\/h.sh' is not in the repo/);
});

test('an empty repo resolves to nothing declared, without issues', async () => {
  const config = await run(loadProfile('/repo'), memoryFiles({}));
  assert.deepEqual([config.skills, config.integrations, config.issues], [[], [], []]);
  assert.deepEqual(config.files.find((f) => f.id === 'claude:settings.json')!.keys, {});
});

test('a read failure is ReadFailed, not an absent file', async () => {
  const failing = Layer.succeed(ProfileFiles, {
    readText: (path: string) => Effect.fail(new ReadFailed({ path, reason: 'denied' })),
    exists: () => Effect.succeed(false),
  });
  const error = await run(Effect.flip(loadProfile('/repo')), failing);
  assert.equal(error._tag, 'ReadFailed');
});

test('requireValid fails with every issue', async () => {
  const config = await run(loadProfile('/repo'), memoryFiles({ '/repo/integrations.json': '{', '/repo/skill-pins.json': '{' }));
  const error = await Effect.runPromise(Effect.flip(requireValid(config)));
  assert.equal(error._tag, 'ProfileInvalid');
  assert.deepEqual(error.issues.map((i) => i.layer), ['base', 'pin']);
  assert.equal(await Effect.runPromise(requireValid({ ...config, issues: [] })).then((c) => c.issues.length), 0);
});

test('nodeFiles reads real files, treats absence as undefined and other errors as ReadFailed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-engine-'));
  try {
    writeFileSync(join(dir, 'skills-manifest.txt'), '[a/b]\nx\n');
    const config = await run(loadProfile(dir), nodeFiles);
    assert.deepEqual(config.skills.map((s) => s.name), ['x']);

    mkdirSync(join(dir, 'integrations.json'));
    const error = await run(Effect.flip(loadProfile(dir)), nodeFiles);
    assert.equal(error._tag, 'ReadFailed');
    assert.equal(error.path, join(dir, 'integrations.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
