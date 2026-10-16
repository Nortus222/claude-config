import { dirname, join, resolve } from 'node:path';
import { Effect } from 'effect';
import type { ResolvedFile } from '@nortuscc/profile-engine';
import { Backups } from '../backups.ts';
import { Fs } from '../fs.ts';
import type { MachineReport, Step, StepResult } from '../model.ts';
import type { MutationObserver } from '../history.ts';
import { MachinePaths } from '../paths.ts';
import { StateStore, withoutBaseline } from '../state.ts';
import { configFileId, filePaths, parseDocument, readCopy, sameCopyEvidence } from './observe.ts';
import { releasedRouting, routingFile, splitMcpRouting } from './mcp-routing.ts';
import { outcomeNote } from './outcome.ts';
import { splitProjectTrust } from './project-trust.ts';

type Restored = { readonly action: 'restored' | 'removed' | 'preserved'; readonly backedUp?: string } | { readonly failed: string };
// Typed constructors, so each helper's generator returns exactly `Restored`.
const restored = (action: 'restored' | 'removed' | 'preserved', backedUp?: string): Restored => ({ action, backedUp });
const failed = (note: string): Restored => ({ failed: note });

// Before #67 (merged 2026-10-05T23:27:15Z), capture backed the repo copy up where an original goes, so a
// backup from an earlier run cannot be told from an original. Hard cutoff (#72): no earlier run is trusted.
export const TRUSTED_ORIGINALS_FROM = 'nortuscc-2026-10-05T23-27-15-000Z';

// The earliest run's backup of a file: what was there before nortuscc first replaced it. When that run
// predates the cutoff, there is no trusted original, and the old backup is returned as `older` to name.
const originalBackup = (file: ResolvedFile) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const { backups } = yield* MachinePaths;
    for (const run of (yield* fs.list(backups)) ?? []) {
      if (!run.startsWith('nortuscc-') || (yield* fs.stat(join(backups, run)))?.kind !== 'directory') continue;
      const candidate = join(backups, run, file.target, file.dest);
      if (yield* fs.stat(candidate)) return run < TRUSTED_ORIGINALS_FROM ? { older: candidate } : { origin: candidate };
    }
    return {};
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
export const restoreFile = (step: Step, report: MachineReport, observer?: MutationObserver) =>
  Effect.gen(function* () {
    const file = report.desired.files.find((f) => f.id === configFileId(step.key));
    if (!file) return { ok: false, note: 'not in the inspected report' } satisfies StepResult;
    const store = yield* StateStore;
    const state = yield* store.read;
    const current = file.mode === 'copy' ? yield* readCopy(file, state.files, state.mcpRouting) : undefined;
    const expected = report.items.find(i => i.key === step.key);
    if (current?.state === 'routing-conflict') return { ok: false, note: current.note! } satisfies StepResult;
    if (current && !sameCopyEvidence(expected?.facts, current)) return { ok: false, note: 'changed since it was inspected; inspect again' } satisfies StepResult;
    const recorded = Object.keys(state.files).filter((k) => k === file.id || k.startsWith(`${file.id}#`));
    if (recorded.length === 0 && !current?.routing?.receipt) return { ok: true, note: 'nothing recorded' } satisfies StepResult;
    const { origin, older } = recorded.length > 0 ? yield* originalBackup(file) : {};
    const { dest } = filePaths(yield* MachinePaths, file);
    const relative = join('uninstall', file.dest);
    const fs = yield* Fs;
    const originalLink = origin && routingFile(file) && (yield* fs.stat(origin))?.kind === 'symlink'
      ? yield* fs.readLink(origin) : undefined;
    const originalPath = originalLink !== undefined ? resolve(dirname(dest), originalLink) : origin;
    const originalText = originalPath && routingFile(file) ? yield* fs.readText(originalPath) : undefined;
    const sameOriginal = Effect.gen(function* () {
      if (!origin || !routingFile(file)) return true;
      const kind = (yield* fs.stat(origin))?.kind;
      if (originalLink !== undefined && (kind !== 'symlink' || (yield* fs.readLink(origin)) !== originalLink)) return false;
      if (originalLink === undefined && kind === 'symlink') return false;
      return (yield* fs.readText(originalPath!)) === originalText;
    });
    if (origin && routingFile(file) && splitMcpRouting(originalText, file.id, state.mcpRouting).status === 'conflict') {
      return { ok: false, note: 'Original backup has a routing conflict; repair it before restoration' } satisfies StepResult;
    }
    if (current?.routing?.receipt) {
      const backups = yield* Backups;
      const paths = yield* MachinePaths;
      // A routing-only receipt owns a span, not the rest of a never-applied document.
      const original = recorded.length === 0 ? current.localBody : originalText;
      const split = splitMcpRouting(original, file.id, state.mcpRouting);
      if (originalLink !== undefined && split.status === 'owned') return { ok: false, note: 'Original backup is a link containing routing; repair its target before restoration' } satisfies StepResult;
      if (split.status === 'conflict') return { ok: false, note: `Original backup has a routing conflict: ${split.note}` } satisfies StepResult;
      yield* backups.preserve(dest, relative, file.target);
      yield* backups.preserve(join(paths.stateRoot, 'state.json'), 'state.json', undefined, { private: true });
      const freshState = yield* store.read;
      const fresh = yield* readCopy(file, freshState.files, freshState.mcpRouting);
      if (!sameCopyEvidence(current.facts, fresh) || fresh.state === 'routing-conflict'
        || !(yield* sameOriginal)) {
        return { ok: false, note: 'changed since it was inspected; inspect again' } satisfies StepResult;
      }
      // Release first. A crash must not authorize later reconciliation to recreate guidance.
      yield* store.update(s => releasedRouting(s, file.id));
      yield* observer?.committed(step.key) ?? Effect.void;
      const persisted = yield* store.read;
      if ((yield* fs.readText(dest)) !== current.localText
        || JSON.stringify(persisted.mcpRouting) !== JSON.stringify(releasedRouting(freshState, file.id).mcpRouting)
        || !(yield* sameOriginal)) {
        return { ok: false, note: 'changed before restoration; inspect again' } satisfies StepResult;
      }
      const backedUp = yield* backups.moveAside(dest, relative, file.target);
      if (originalLink !== undefined && origin && recorded.length > 0) yield* putBack(origin, dest);
      else if (split.body !== undefined) yield* fs.writeTextAtomic(dest, split.body);
      yield* store.update(s => recorded.reduce(withoutBaseline, s));
      return { ok: true, note: outcomeNote(recorded.length === 0 ? 'preserved' : origin ? 'restored' : 'removed', backedUp, older) } satisfies StepResult;
    }
    if (current) {
      const freshState = yield* store.read;
      const fresh = yield* readCopy(file, freshState.files, freshState.mcpRouting);
      if (!sameCopyEvidence(current.facts, fresh) || fresh.state === 'routing-conflict'
        || !(yield* sameOriginal)) {
        return { ok: false, note: 'changed since it was inspected; inspect again' } satisfies StepResult;
      }
    }
    const result = file.mode === 'merge-keys' ? yield* restoreMerged(file, dest, origin, recorded, relative)
      : file.preserveProjects ? yield* restoreProjects(file, dest, origin, relative)
      : yield* restoreCopy(file, dest, origin, relative);
    if ('failed' in result) return { ok: false, note: result.failed } satisfies StepResult;
    yield* store.update((s) => recorded.reduce(withoutBaseline, s));
    return { ok: true, note: outcomeNote(result.action, result.backedUp, older) } satisfies StepResult;
  });
