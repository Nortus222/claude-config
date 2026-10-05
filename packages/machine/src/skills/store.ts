import { dirname, join } from 'node:path';
import { Effect } from 'effect';
import type { Target } from '@nortuscc/profile-engine';
import { Fs } from '../fs.ts';
import { MachinePaths, type MachinePathsValue } from '../paths.ts';
import { SKILL_AGENTS } from './installer.ts';
import type { SkillLock } from './manifest.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A sibling of the store, so redirecting the store (NORTUSCC_AGENTS_DIR) redirects the lock too.
export const skillLockPath = (paths: MachinePathsValue) => join(dirname(paths.agentsSkills), '.skill-lock.json');

// The installer owns the lock; anything unreadable or misshapen degrades to "nothing known".
export const readSkillLock: Effect.Effect<SkillLock, never, Fs | MachinePaths> = Effect.gen(function* () {
  const fs = yield* Fs;
  const text = yield* fs.readText(skillLockPath(yield* MachinePaths)).pipe(Effect.orElseSucceed(() => undefined));
  if (text === undefined) return { skills: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    return { skills: isRecord(parsed) && isRecord(parsed.skills) ? parsed.skills : {} } as SkillLock;
  } catch {
    return { skills: {} };
  }
});

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
    else errors.push(`could not read the skill directory for ${SKILL_AGENTS[target]}: ${result.failure.message}`);
  }
  return { list, errors };
});

// Classifies names by how many of `targets` can load them; an agent without a list sees nothing.
export function skillExposure(input: {
  readonly names: ReadonlyArray<string>;
  readonly targets: ReadonlyArray<Target>;
  readonly list: Partial<Record<Target, ReadonlyArray<string>>>;
}) {
  const exposed: string[] = [];
  const partial: { name: string; missing: Target[] }[] = [];
  const missing: string[] = [];
  for (const name of input.names) {
    const lacking = input.targets.filter((t) => !(input.list[t] ?? []).includes(name));
    if (lacking.length === 0) exposed.push(name);
    else if (lacking.length === input.targets.length) missing.push(name);
    else partial.push({ name, missing: lacking });
  }
  return { exposed, partial, missing };
}
