import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Effect } from 'effect';
import { Backups, Fs, MachinePaths, type Disposition, type Domain, type Observed } from '@nortuscc/machine';
import type { DesktopServices } from '../../backend/session.ts';

// A test machine described by <stateRoot>/fake-machine.json. `slow` steps are interruptible and
// never finish; `sleepy` steps are file-like units that take 300 ms; `fail` steps fail; `loud` steps
// fail with a 2 MB message, as an installer's captured output might.
export type FakeItem = { key: string; disposition: Disposition; behavior?: 'slow' | 'sleepy' | 'fail' | 'loud' };

const machineFile = (stateRoot: string) => join(stateRoot, 'fake-machine.json');
export const appliedFile = (stateRoot: string, key: string) => join(stateRoot, 'applied', encodeURIComponent(key));

export const writeFakeMachine = (stateRoot: string, items: ReadonlyArray<FakeItem>) => {
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(machineFile(stateRoot), JSON.stringify({ items }));
};

const readItems = Effect.gen(function* () {
  const { stateRoot } = yield* MachinePaths;
  const text = yield* (yield* Fs).readText(machineFile(stateRoot));
  return text === undefined ? [] : (JSON.parse(text).items as FakeItem[]);
});

export const fakeDomain: Domain<DesktopServices> = {
  name: 'config',
  inspect: () =>
    readItems.pipe(
      Effect.map((items) => ({
        items: items.map((item): Observed => ({
          key: item.key,
          domain: 'config',
          target: 'claude',
          label: item.key,
          group: 'Fake files',
          state: item.disposition === 'in-sync' ? 'clean' : 'repo-ahead',
          disposition: item.disposition,
          from: { layer: 'base', source: 'fake' },
          ...(item.behavior ? { note: item.behavior } : {}),
        })),
        probeErrors: [],
      })),
      Effect.orElseSucceed(() => ({ items: [], probeErrors: ['fake machine unreadable'] })),
    ),
  steps: (items) => ({
    steps: items.filter((i) => i.disposition === 'apply').map((i) => ({
      key: i.key, domain: 'config' as const, action: 'write-file' as const, summary: `write ${i.key}`, touches: [i.key], interruptible: i.note === 'slow',
    })),
    skipped: items.filter((i) => i.disposition === 'blocked').map((i) => ({ key: i.key, reason: 'blocked' })),
  }),
  run: (step, report) =>
    Effect.gen(function* () {
      const note = report.items.find((i) => i.key === step.key)?.note;
      if (note === 'slow') return yield* Effect.never;
      if (note === 'fail') return yield* Effect.fail(new Error(`fake failure for ${step.key}`));
      if (note === 'loud') return yield* Effect.fail(new Error('x'.repeat(2_000_000)));
      if (note === 'sleepy') yield* Effect.sleep('300 millis');
      const { stateRoot } = yield* MachinePaths;
      const fs = yield* Fs;
      const target = appliedFile(stateRoot, step.key);
      yield* (yield* Backups).preserve(target, encodeURIComponent(step.key));
      yield* fs.writeTextAtomic(target, 'applied\n');
      const items = (yield* readItems).map((i) => (i.key === step.key ? { ...i, disposition: 'in-sync' as const } : i));
      yield* fs.writeTextAtomic(machineFile(stateRoot), JSON.stringify({ items }));
      return { ok: true };
    }),
};
