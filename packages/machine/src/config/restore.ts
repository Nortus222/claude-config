import { join } from 'node:path';
import { Effect } from 'effect';
import type { ResolvedFile } from '@nortuscc/profile-engine';
import { Backups } from '../backups.ts';
import { Fs } from '../fs.ts';
import type { MachineReport, Step, StepResult } from '../model.ts';
import { MachinePaths } from '../paths.ts';
import { StateStore, withoutBaseline } from '../state.ts';
import { configFileId, filePaths, parseDocument } from './observe.ts';
import { outcomeNote } from './outcome.ts';
import { splitProjectTrust } from './project-trust.ts';

type Restored = { readonly action: 'restored' | 'removed' | 'preserved'; readonly backedUp?: string } | { readonly failed: string };
// Typed constructors, so each helper's generator returns exactly `Restored`.
const restored = (action: 'restored' | 'removed' | 'preserved', backedUp?: string): Restored => ({ action, backedUp });
const failed = (note: string): Restored => ({ failed: note });

// The earliest run's backup of a file: what was there before nortuscc first replaced it.
const originalBackup = (file: ResolvedFile) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const { backups } = yield* MachinePaths;
    for (const run of (yield* fs.list(backups)) ?? []) {
      if (!run.startsWith('nortuscc-') || (yield* fs.stat(join(backups, run)))?.kind !== 'directory') continue;
      const candidate = join(backups, run, file.target, file.dest);
      if (yield* fs.stat(candidate)) return candidate;
    }
    return undefined;
  });

// A link is restored as the same link, anything else as a copy.
const putBack = (origin: string, dest: string) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    if ((yield* fs.stat(origin))?.kind === 'symlink') yield* fs.symlink(yield* fs.readLink(origin), dest);
    else yield* fs.copy(origin, dest);
  });

const restoreCopy = (file: ResolvedFile, dest: string, origin: string | undefined, relative: string) =>
  Effect.gen(function* () {
    const backedUp = yield* (yield* Backups).moveAside(dest, relative, file.target);
    if (origin) yield* putBack(origin, dest);
    return restored(origin ? 'restored' : 'removed', backedUp);
  });

// The original's managed part, with whatever project tables the machine holds now.
const restoreProjects = (file: ResolvedFile, dest: string, origin: string | undefined, relative: string) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const backups = yield* Backups;
    const current = yield* fs.readText(dest);
    if (current === undefined) {
      if (origin) yield* putBack(origin, dest);
      return restored(origin ? 'restored' : 'removed');
    }
    const projects = splitProjectTrust(current).projects;
    const managed = origin ? splitProjectTrust((yield* fs.readText(origin)) ?? '').managed : '';
    const next = managed && projects ? `${managed}\n${projects}` : managed || projects;
    if (!next) return restored('removed', yield* backups.moveAside(dest, relative, file.target));
    const backedUp = yield* backups.preserve(dest, relative, file.target);
    yield* fs.writeTextAtomic(dest, next);
    return restored(origin ? 'restored' : 'preserved', backedUp);
  });

// Each recorded key goes back to its original value, or away; every other key stays as it is now.
// A backup that is a link holds no copy of the settings before nortuscc, so nothing is changed.
const restoreMerged = (file: ResolvedFile, dest: string, origin: string | undefined, recorded: ReadonlyArray<string>, relative: string) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const backups = yield* Backups;
    if (origin && (yield* fs.stat(origin))?.kind === 'symlink') {
      return failed(`the backup ${origin} is a link, not a copy: the settings before nortuscc cannot be recovered from it. Edit ${dest} by hand, or delete the backup.`);
    }
    const current = parseDocument(yield* fs.readText(dest));
    if (current.kind !== 'object') {
      const backedUp = current.kind === 'corrupt' ? yield* backups.moveAside(dest, relative, file.target) : undefined;
      if (origin) yield* putBack(origin, dest);
      return restored(origin ? 'restored' : 'removed', backedUp);
    }
    const original = origin ? parseDocument(yield* fs.readText(origin)) : { kind: 'object' as const, value: {} };
    if (original.kind !== 'object') return failed(`the backup ${origin} is not a JSON object`);
    const next: Record<string, unknown> = { ...current.value };
    for (const recordedKey of recorded) {
      if (!recordedKey.startsWith(`${file.id}#`)) continue;
      const key = recordedKey.slice(file.id.length + 1);
      if (Object.hasOwn(original.value, key)) next[key] = original.value[key];
      else delete next[key];
    }
    if (Object.keys(next).length === 0 && !origin) return restored('removed', yield* backups.moveAside(dest, relative, file.target));
    const backedUp = yield* backups.preserve(dest, relative, file.target);
    yield* fs.writeTextAtomic(dest, JSON.stringify(next, null, 2) + '\n');
    return restored('restored', backedUp);
  });

// uninstall: put one recorded file back as it was before nortuscc, then forget its baselines.
export const restoreFile = (step: Step, report: MachineReport) =>
  Effect.gen(function* () {
    const file = report.desired.files.find((f) => f.id === configFileId(step.key));
    if (!file) return { ok: false, note: 'not in the inspected report' } satisfies StepResult;
    const store = yield* StateStore;
    const recorded = Object.keys((yield* store.read).files).filter((k) => k === file.id || k.startsWith(`${file.id}#`));
    if (recorded.length === 0) return { ok: true, note: 'nothing recorded' } satisfies StepResult;
    const origin = yield* originalBackup(file);
    const { dest } = filePaths(yield* MachinePaths, file);
    const relative = join('uninstall', file.dest);
    const result = file.mode === 'merge-keys' ? yield* restoreMerged(file, dest, origin, recorded, relative)
      : file.preserveProjects ? yield* restoreProjects(file, dest, origin, relative)
      : yield* restoreCopy(file, dest, origin, relative);
    if ('failed' in result) return { ok: false, note: result.failed } satisfies StepResult;
    yield* store.update((s) => recorded.reduce(withoutBaseline, s));
    return { ok: true, note: outcomeNote(result.action, result.backedUp) } satisfies StepResult;
  });
