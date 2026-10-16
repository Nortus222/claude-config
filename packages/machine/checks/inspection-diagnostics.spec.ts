import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Effect } from 'effect';
import { FileIntegrity, nodeFileIntegrity, Fs, FsFailed, MachinePaths, StateStore, inspectSkills, readExposure } from '../src/index.ts';
import { inspectConfig } from '../src/config/inspect.ts';
import { inspectHook } from '../src/integrations/hooks.ts';
import { configMachine } from './config-machine.ts';
import { HOOK } from './support/integrations.ts';

for (const kind of ['config', 'hook', 'skill store', 'skill exposure'] as const) {
  test(`${kind} inspection diagnostics omit filesystem exception text`, async t => {
    const m = configMachine();
    t.after(() => rmSync(m.root, { recursive: true, force: true }));
    const desired = await m.desired();
    const result = await Effect.runPromise(Effect.gen(function* () {
      const fs = yield* Fs;
      const failed = (path: string) => Effect.fail(new FsFailed({ op: 'read', path, reason: 'FAKE_TOKEN' }));
      const failingFs = { ...fs, readText: failed, list: failed };
      const read: Effect.Effect<unknown, never, FileIntegrity | Fs | MachinePaths | StateStore> = kind === 'config' ? inspectConfig(desired)
        : kind === 'hook' ? inspectHook(m.paths.claude, HOOK)
        : kind === 'skill store' ? inspectSkills(desired)
        : readExposure(['claude', 'codex']);
      return yield* read.pipe(Effect.provideService(Fs, failingFs), Effect.provide(nodeFileIntegrity));
    }).pipe(Effect.provide(m.layer())));
    const text = JSON.stringify(result);
    assert.ok(!text.includes('FAKE_TOKEN'));
    assert.match(text, /check.*(access|permissions)/i);
  });
}
