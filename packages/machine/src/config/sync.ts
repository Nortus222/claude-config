import { Effect } from 'effect';
import { parseSettingsKeys, type DesiredConfig, type ResolvedFile } from '@nortuscc/profile-engine';
import { Backups } from '../backups.ts';
import { Fs } from '../fs.ts';
import type { MachineReport, Step, StepResult } from '../model.ts';
import { MachinePaths } from '../paths.ts';
import { StateStore, withBaseline, withoutBaseline, type MachineState } from '../state.ts';
import { hashValue } from './file-state.ts';
import { configFileId, contentHash, filePaths, parseDocument, readCopy, readMerge, settingsKeyOf } from './observe.ts';
import { outcomeNote } from './outcome.ts';
import { splitProjectTrust } from './project-trust.ts';

const MOVED: StepResult = { ok: false, note: 'changed since it was inspected; inspect again' };
const IN_SYNC: StepResult = { ok: true, note: 'in sync' };
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

// One copied file, either direction. Converged: only the baseline moves.
const syncCopy = (step: Step, file: ResolvedFile, expected: string) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const backups = yield* Backups;
    const store = yield* StateStore;
    const { src, dest } = filePaths(yield* MachinePaths, file);
    const now = yield* readCopy(file, (yield* store.read).files);
    if (now.state !== expected) return MOVED;
    if (now.state === 'clean') {
      yield* store.update((s) => withBaseline(s, file.id, contentHash(file, now.localText)!));
      return IN_SYNC;
    }
    if (step.action === 'capture-file') {
      if (now.localText === undefined) return { ok: true, note: 'nothing to capture' };
      // The repo file is a working-tree file: an uncommitted edit is not recoverable from git.
      const backedUp = yield* backups.moveAside(src, file.dest, file.target);
      yield* fs.writeTextAtomic(src, now.localText);
      yield* store.update((s) => withBaseline(s, file.id, contentHash(file, now.localText)!));
      return { ok: true, note: outcomeNote('copied', backedUp) };
    }
    if (now.repoText === undefined) return { ok: false, note: 'missing from the repo' };
    const projects = file.preserveProjects && now.localText !== undefined ? splitProjectTrust(now.localText).projects : '';
    const text = file.preserveProjects ? splitProjectTrust(now.repoText).managed + (projects ? `\n${projects}` : '') : now.repoText;
    const backedUp = yield* backups.moveAside(dest, file.dest, file.target);
    yield* fs.writeTextAtomic(dest, text);
    yield* store.update((s) => withBaseline(s, file.id, contentHash(file, text)!));
    return { ok: true, note: outcomeNote('copied', backedUp) };
  });

// Baselines of keys the repo document no longer owns: nothing will reconcile them again.
const pruned = (file: ResolvedFile) => (state: MachineState): MachineState =>
  Object.keys(state.files)
    .filter((k) => k.startsWith(`${file.id}#`) && !Object.hasOwn(file.keys ?? {}, k.slice(file.id.length + 1)))
    .reduce(withoutBaseline, state);

// One settings key, either direction. Keys the repo does not name are never touched.
const syncKey = (step: Step, file: ResolvedFile, desired: DesiredConfig, expected: string) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const backups = yield* Backups;
    const store = yield* StateStore;
    const { src, dest } = filePaths(yield* MachinePaths, file);
    const key = settingsKeyOf(step.key)!;
    const owned = file.keys?.[key];
    const now = yield* readMerge(file, desired, (yield* store.read).files);
    if (!owned || now.readings.find((r) => r.key === step.key)?.state !== expected) return MOVED;
    const record = (hash: string) => store.update((s) => pruned(file)(withBaseline(s, `${file.id}#${key}`, hash)));
    const local = now.local.kind === 'object' ? now.local.value : {};
    if (expected === 'clean') {
      yield* record(hashValue(owned.value)!);
      return IN_SYNC;
    }
    if (step.action === 'merge-keys') {
      // A copy, not a move: the rest of the document stays where it is.
      const backedUp = yield* backups.preserve(dest, file.dest, file.target);
      yield* fs.writeTextAtomic(dest, json({ ...local, [key]: owned.value }));
      yield* record(hashValue(owned.value)!);
      return { ok: true, note: outcomeNote('copied', backedUp) };
    }
    const value = Object.hasOwn(local, key) ? local[key] : undefined;
    if (value === undefined) return { ok: true, note: 'nothing to capture' };
    const repo = parseDocument(now.repoText);
    if (repo.kind !== 'object') return { ok: false, note: `${file.src} is not a JSON object` };
    const next = { ...repo.value, [key]: value };
    // The repo file is committed: a local credential must never land in it.
    const issues = parseSettingsKeys(json(next), file.src).issues;
    if (issues.length) return { ok: false, note: `refused: ${issues.map((i) => i.message).join('; ')}` };
    const backedUp = yield* backups.preserve(src, `${file.dest}.repo`, file.target);
    yield* fs.writeTextAtomic(src, json(next));
    yield* record(hashValue(value)!);
    return { ok: true, note: outcomeNote('copied', backedUp) };
  });

// apply and capture: re-read the file, refuse if its state moved since the report, then write.
export const syncFile = (step: Step, report: MachineReport) => {
  const item = report.items.find((i) => i.key === step.key);
  const file = report.desired.files.find((f) => f.id === configFileId(step.key));
  if (!item || !file) return Effect.succeed<StepResult>({ ok: false, note: 'not in the inspected report' });
  return file.mode === 'copy' ? syncCopy(step, file, item.state) : syncKey(step, file, report.desired, item.state);
};
