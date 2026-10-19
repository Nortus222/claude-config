import { dirname, join } from 'node:path';
import { Effect } from 'effect';
import type { Target } from '@nortuscc/profile-engine';
import { FsFailed } from '../errors.ts';
import { Fs } from '../fs.ts';
import { MachinePaths, type MachinePathsValue } from '../paths.ts';
import { isSkillCandidateSelector, nativeInstalledName } from './candidates.ts';
import { SKILL_AGENTS } from './installer.ts';
import type { SkillLock } from './manifest.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The skills installer treats skill names case-insensitively but keeps each skill's own spelling, so a declared
// `TDD` may be installed, locked and exposed as `tdd`. This is the one name comparison for that.
export const sameSkillName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// The one of `names` that `name` refers to: an exact name wins, otherwise a unique case-insensitive match;
// an ambiguous fold finds none.
export const matchSkillName = (names: Iterable<string>, name: string): string | undefined => {
  let folded: string | undefined;
  let count = 0;
  for (const candidate of names) {
    if (candidate === name) return name;
    if (sameSkillName(candidate, name)) { folded = candidate; count++; }
  }
  return count === 1 ? folded : undefined;
};

// A sibling of the store, so redirecting the store (NORTUSCC_AGENTS_DIR) redirects the lock too.
export const skillLockPath = (paths: MachinePathsValue) => join(dirname(paths.agentsSkills), '.skill-lock.json');

const decodeSkillLock = (bytes: Uint8Array | undefined, path: string): Effect.Effect<SkillLock, FsFailed> => {
  if (bytes === undefined) return Effect.succeed({ skills: {} });
  return Effect.try({ try: () => {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isRecord(parsed) || !isRecord(parsed.skills)) throw new Error('invalid');
    return { skills: parsed.skills };
  }, catch: () => new FsFailed({ op: 'read', path, reason: 'Native skill lock is unavailable or invalid' }) });
};
// Authorizing update reads retain exact bytes and refuse unavailable or malformed evidence.
export const readSkillLockEvidence = Effect.gen(function* () {
  const fs = yield* Fs; const path = skillLockPath(yield* MachinePaths);
  const bytes = yield* fs.readBytes(path);
  return { lock: yield* decodeSkillLock(bytes,path), bytes };
});
// Legacy observations retain their non-authorizing fallback through the same native lock decoder.
export const readSkillLock: Effect.Effect<SkillLock, never, Fs | MachinePaths> = Effect.gen(function* () {
  const fs = yield* Fs; const path = skillLockPath(yield* MachinePaths);
  const text = yield* fs.readText(path);
  return yield* decodeSkillLock(text === undefined ? undefined : new TextEncoder().encode(text),path);
}).pipe(Effect.catch(() => Effect.succeed({ skills: {} })));

// Skill folders (or links to them) in the shared store, sorted.
export const installedSkillNames = Effect.gen(function* () {
  const fs = yield* Fs;
  const store = (yield* MachinePaths).agentsSkills;
  const names = (yield* fs.list(store)) ?? [];
  const kept: string[] = [];
  for (const name of names) {
    const kind = (yield* fs.stat(join(store, name)))?.kind;
    if (kind === 'directory' || kind === 'symlink') kept.push(name);
  }
  return kept.sort();
});

// Every directory an agent loads skills from. Codex reads the shared store itself; Claude only its own.
export const agentSkillsDirs = (paths: MachinePathsValue, target: Target): string[] =>
  target === 'codex' ? [paths.agentsSkills, join(paths.codex, 'skills')] : [join(paths.claude, 'skills')];

// Names an agent can load: non-dot entries that resolve, so a dangling link reads as absent.
const exposedSkillNames = (target: Target) => Effect.gen(function* () {
  const fs = yield* Fs;
  const names = new Set<string>();
  for (const dir of agentSkillsDirs(yield* MachinePaths, target)) {
    for (const name of (yield* fs.list(dir)) ?? []) {
      if (name.startsWith('.')) continue;
      if ((yield* fs.realPath(join(dir, name))) !== undefined) names.add(name);
    }
  }
  return [...names].sort();
});

// Per-agent loadable names. A directory that cannot be read is an error and its agent is left out,
// so a failed read can never look like "this agent has no skills" and trigger a reinstall of all of them.
export const readExposure = (targets: ReadonlyArray<Target>): Effect.Effect<
  { list: Partial<Record<Target, string[]>>; errors: string[] },
  never,
  Fs | MachinePaths
> => Effect.gen(function* () {
  const list: Partial<Record<Target, string[]>> = {};
  const errors: string[] = [];
  for (const target of targets) {
    const result = yield* Effect.result(exposedSkillNames(target));
    if (result._tag === 'Success') list[target] = result.success;
    else errors.push(`could not read the skill directory for ${SKILL_AGENTS[target]}; check directory access and permissions`);
  }
  return { list, errors };
});

// Classifies names by how many of `targets` can load them, matching names as the installer does;
// an agent without a list sees nothing.
export function skillExposure(input: {
  readonly names: ReadonlyArray<string>;
  readonly targets: ReadonlyArray<Target>;
  readonly list: Partial<Record<Target, ReadonlyArray<string>>>;
}) {
  const exposed: string[] = [];
  const partial: { name: string; missing: Target[] }[] = [];
  const missing: string[] = [];
  for (const name of input.names) {
    const lacking = input.targets.filter((t) => matchSkillName(input.list[t] ?? [], name) === undefined);
    if (lacking.length === 0) exposed.push(name);
    else if (lacking.length === input.targets.length) missing.push(name);
    else partial.push({ name, missing: lacking });
  }
  return { exposed, partial, missing };
}

// Vendor lock keys are native metadata selectors, distinct from sanitized store folders.
// Only addition-aware callers opt into this mapping; ambiguous aliases never select a source.
export const additionLockEntry = (lock: SkillLock, name: string): { readonly selectorName: string; readonly meta: unknown } | undefined => {
  const matches = Object.entries(lock.skills).filter(([selector]) => isSkillCandidateSelector(selector) && nativeInstalledName(selector) === name);
  if (matches.length !== 1) return undefined;
  return { selectorName: matches[0]![0], meta: matches[0]![1] };
};
