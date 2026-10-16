import { dirname, join } from 'node:path';
import { Effect } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import { Backups } from '../backups.ts';
import { FileIntegrity } from '../file-integrity.ts';
import { Fs } from '../fs.ts';
import { MachinePaths } from '../paths.ts';
import type { StepResult } from '../model.ts';
import { additionLockEntry, skillLockPath } from './store.ts';

export const safeSkillName = (name: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(name) && !['constructor', '__proto__'].includes(name);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type OwnedSkill = {
  readonly kind: 'owned';
  readonly name: string;
  readonly shared: string;
  readonly sharedPresent: boolean;
  readonly exposures: readonly string[];
  readonly lockPath: string;
  readonly lockText: string;
  readonly document: Record<string, unknown> & { skills: Record<string, unknown> };
  readonly digest: string | null;
  readonly selectorName: string;
};
export type SkillOwnership = OwnedSkill | { readonly kind: 'absent' }
  | { readonly kind: 'blocked'; readonly reason: string };

// Positive ownership covers every known exposure, even targets excluded from this apply.
export const checkSkillOwnership = (desired: DesiredConfig, name: string, previous?: OwnedSkill): Effect.Effect<
  SkillOwnership, never, Fs | MachinePaths | FileIntegrity
> => Effect.gen(function* () {
  const blocked = (reason: string): SkillOwnership => ({ kind: 'blocked', reason });
  if (!safeSkillName(name)) return blocked('unsafe skill name');
  const declared = desired.skills.filter((skill) => skill.name === name);
  if (declared.length !== 1) return blocked('skill declaration is missing or ambiguous');
  const fs = yield* Fs;
  const paths = yield* MachinePaths;
  const integrity = yield* FileIntegrity;
  const shared = join(paths.agentsSkills, name);
  const lockPath = skillLockPath(paths);
  const exposureDirs = [join(paths.claude, 'skills'), join(paths.codex, 'skills')];
  for (const dir of [dirname(paths.agentsSkills), paths.agentsSkills, paths.claude, paths.codex, ...exposureDirs]) {
    const info = yield* fs.stat(dir);
    if (info && info.kind !== 'directory') return blocked('skill storage is not a regular directory');
  }
  const present = yield* fs.stat(shared);
  const lockStat = yield* fs.stat(lockPath);
  const exposureStats = yield* Effect.all(exposureDirs.map((dir) => fs.stat(join(dir, name))));
  if (!present && !lockStat && exposureStats.every((info) => !info)) return { kind: 'absent' as const };
  if (lockStat?.kind !== 'file') return blocked('installer lock is missing or not a regular file');
  const lockText = yield* fs.readText(lockPath);
  if (lockText === undefined || Buffer.byteLength(lockText) > 1024 * 1024) return blocked('installer lock is unavailable');
  let document: unknown;
  try { document = JSON.parse(lockText); } catch { return blocked('installer lock is invalid'); }
  if (!record(document) || !record(document.skills)) return blocked('installer lock is invalid');
  const selected = additionLockEntry({ skills: document.skills }, name);
  if (!selected) return !present && exposureStats.every((info) => !info) && !Object.hasOwn(document.skills, name)
    ? { kind: 'absent' as const } : blocked('skill has no unique installer ownership record');
  const entry = selected.meta;
  if (!record(entry) || entry.source !== declared[0]!.source) return blocked('skill source does not match the setup');
  if (present && present.kind !== 'directory') return blocked('shared skill is not a regular directory');
  // A retained own record with all destinations gone is a safe retry of the final lock patch.
  if (!present && exposureStats.some(Boolean)) return blocked('shared content is unavailable for exposure comparison');
  const digest = present ? yield* integrity.digestTree(shared, { includeEntryModes: true }) : null;
  const sharedReal = present ? yield* fs.realPath(shared) : undefined;
  const exposures: string[] = [];
  for (const [index, info] of exposureStats.entries()) {
    if (!info) continue;
    const path = join(exposureDirs[index]!, name);
    if (info.kind === 'symlink') {
      const real = yield* fs.realPath(path);
      if (real === undefined || real !== sharedReal) return blocked('skill exposure points elsewhere');
    } else {
      if (info.kind !== 'directory') return blocked('skill exposure differs from the managed copy');
      const exposureDigest = yield* integrity.digestTree(path, { includeEntryModes: true });
      const unchangedOwned = previous?.name === name && previous.shared === shared && previous.exposures.includes(path) && exposureDigest === previous.digest;
      if (exposureDigest !== digest && !unchangedOwned) return blocked('skill exposure differs from the managed copy');
    }
    exposures.push(path);
  }
  return { kind: 'owned' as const, name, shared, sharedPresent: !!present, exposures, lockPath, lockText,
    document: document as OwnedSkill['document'], selectorName: selected.selectorName, digest };
}).pipe(Effect.catch(() => Effect.succeed({ kind: 'blocked', reason: 'skill ownership could not be read' } as const)));

// Preserve all known destinations and the raw lock before an installer replaces content.
export const preserveSkillDestinations = (names: readonly string[]) => Effect.gen(function* () {
  const paths = yield* MachinePaths;
  const backups = yield* Backups;
  for (const name of names) {
    if (!safeSkillName(name)) return yield* Effect.fail(new Error('unsafe skill name'));
    yield* backups.preserve(join(paths.agentsSkills, name), join('skills', name));
    yield* backups.preserve(join(paths.claude, 'skills', name), join('skills', name), 'claude');
    yield* backups.preserve(join(paths.codex, 'skills', name), join('skills', name), 'codex');
  }
  yield* backups.preserve(skillLockPath(paths), '.skill-lock.json');
});

// Caller holds apply.lock. Deletion failure retains ownership metadata for an honest retry.
export const disableOwnedSkill = (desired: DesiredConfig, name: string): Effect.Effect<
  StepResult, unknown, Fs | MachinePaths | FileIntegrity | Backups
> => Effect.gen(function* () {
  const skill = desired.skills.filter((skill) => skill.name === name);
  if (skill.length !== 1 || skill[0]!.install || skill[0]!.from.layer !== 'machine') {
    return { ok: false, note: 'skill is not explicitly disabled' };
  }
  const owned = yield* checkSkillOwnership(desired, name);
  if (owned.kind === 'blocked') return { ok: false, note: owned.reason };
  if (owned.kind === 'absent') return { ok: true, note: 'already disabled' };
  yield* preserveSkillDestinations([name]);
  const fs = yield* Fs;
  // Backup reads can take time. Revalidate before entering the small noninterruptible mutation.
  const fresh = yield* checkSkillOwnership(desired, name);
  if (fresh.kind !== 'owned' || fresh.lockText !== owned.lockText || fresh.digest !== owned.digest
    || JSON.stringify(fresh.exposures) !== JSON.stringify(owned.exposures)) {
    return { ok: false, note: 'skill ownership changed; review again' };
  }
  return yield* Effect.uninterruptible(Effect.gen(function* () {
    const removed = yield* Effect.result(Effect.gen(function* () {
      for (const path of fresh.exposures) yield* fs.remove(path);
      if (fresh.sharedPresent) yield* fs.remove(fresh.shared);
    }));
    if (removed._tag === 'Failure') return { ok: false, note: 'disable incomplete; ownership record retained for retry' };
    if ((yield* fs.stat(fresh.lockPath))?.kind !== 'file' || (yield* fs.readText(fresh.lockPath)) !== fresh.lockText) {
      return { ok: false, note: 'content removed, but installer lock changed; review again' };
    }
    const skills = { ...fresh.document.skills };
    delete skills[fresh.selectorName];
    const patched = yield* Effect.result(fs.writeTextAtomic(fresh.lockPath,
      JSON.stringify({ ...fresh.document, skills }, null, 2) + '\n'));
    return patched._tag === 'Success' ? { ok: true, note: 'disabled owned skill' }
      : { ok: false, note: 'content removed, but ownership record remains; retry disable' };
  }));
});
