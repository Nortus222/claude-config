import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { Effect } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import type { FsFailed } from '../errors.ts';
import { Fs } from '../fs.ts';
import type { Observed } from '../model.ts';
import { MachinePaths } from '../paths.ts';
import { Processes, type Command } from '../processes.ts';
import type { SkillLock } from './manifest.ts';
import { lockRef, offPinNote, pinsBySource, short } from './pins.ts';
import { installedSkillNames, readSkillLock } from './store.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

// The lock records the path of a skill's SKILL.md, but the tree SHA that
// identifies a version belongs to the directory containing it. A SKILL.md at
// the repo root has no containing directory, so it maps to '.' — git's own
// name for the root tree.
export function skillFolder(skillPath: string): string {
  const dir = dirname(skillPath);
  return dir === '' || dir === '/' ? '.' : dir;
}

export type UpdatableSkill = {
  readonly name: string;
  readonly source: string;
  readonly sourceUrl: string;
  readonly path: string;
  readonly hash: string | null;
};

// An entry is updatable only if it names both where it came from and where it
// lives in that repo. A source with no skillPath cannot be located upstream,
// so there is no SHA to compare and nothing this command could do with it.
export function updatableSkills(lock: SkillLock, installed: ReadonlyArray<string>): UpdatableSkill[] {
  const skills = isRecord(lock) && isRecord(lock.skills) ? lock.skills : {};
  const entries: UpdatableSkill[] = [];
  for (const name of installed) {
    const meta = skills[name];
    if (!isRecord(meta)) continue;
    const source = str(meta.source);
    const skillPath = str(meta.skillPath);
    if (!source || !skillPath) continue;
    entries.push({
      name,
      source,
      // Older lock entries predate sourceUrl; the "owner/repo" shorthand is
      // what `git clone` accepts from GitHub anyway, so it is a safe fallback.
      sourceUrl: str(meta.sourceUrl) || `https://github.com/${source}.git`,
      path: skillFolder(skillPath),
      hash: str(meta.skillFolderHash),
    });
  }
  return entries;
}

export type SourceCheck = {
  readonly source: string;
  readonly sourceUrl: string;
  readonly paths: string[];
  readonly exact: boolean;
};

// Grouped by sourceUrl, because that is what gets cloned — two sources that
// differ only in shorthand would otherwise be fetched twice. Plain code-point
// ordering, not localeCompare, so the order is locale-independent.
//
// `exact` names the sources the manifest pinned. It is keyed by source rather
// than by url because that is what the manifest writes; two shorthands for one
// url that disagree about pinning collapse to the first, which is the same
// first-wins rule the grouping itself already applies.
export function sourcesOf(entries: ReadonlyArray<UpdatableSkill>, exact: ReadonlySet<string>): SourceCheck[] {
  const byUrl = new Map<string, SourceCheck>();
  for (const entry of entries) {
    let check = byUrl.get(entry.sourceUrl);
    if (!check) {
      check = { source: entry.source, sourceUrl: entry.sourceUrl, paths: [], exact: exact.has(entry.source) };
      byUrl.set(entry.sourceUrl, check);
    }
    check.paths.push(entry.path);
  }
  return [...byUrl.values()].sort((a, b) => byCodePoint(a.sourceUrl, b.sourceUrl));
}

export type Upstream = {
  readonly trees: Map<string, string | null>;
  readonly skillPaths: string[];
};

export type UpdatePlan = {
  current: { name: string; source: string }[];
  outdated: { name: string; source: string; from: string | null; to: string }[];
  gone: { name: string; source: string; path: string }[];
  unknown: { name: string; source: string }[];
  local: string[];
  available: { name: string; source: string }[];
  // Pinned skills whose lock records another ref; present only when planUpdates was given pins.
  offPin?: { name: string; source: string; from: string | null; to: string }[];
};

// A skill whose lock source is pinned is judged by its recorded ref against the pin, never against
// upstream HEAD, so it needs no remote tree and is never `unknown`.
export function planUpdates(input: {
  lock: SkillLock;
  installed: ReadonlyArray<string>;
  remoteTrees: Map<string, Map<string, string | null>>;
  pins?: ReadonlyMap<string, string>;
}): Omit<UpdatePlan, 'available'> {
  const names = [...input.installed].sort();
  const entries = updatableSkills(input.lock, names);
  const updatable = new Set(entries.map((e) => e.name));

  const plan: Omit<UpdatePlan, 'available'> = { current: [], outdated: [], gone: [], unknown: [], local: [] };

  // Nothing could ever update a skill with no recorded source, so it is
  // reported and skipped — the same treatment groupsFromLock gives it when
  // deciding what may be written to the manifest.
  for (const name of names) if (!updatable.has(name)) plan.local.push(name);

  const offPin: NonNullable<UpdatePlan['offPin']> = [];
  for (const entry of entries) {
    const pin = input.pins?.get(entry.source);
    if (pin !== undefined) {
      const recorded = lockRef(input.lock.skills[entry.name]);
      if (recorded === pin) plan.current.push({ name: entry.name, source: entry.source });
      else offPin.push({ name: entry.name, source: entry.source, from: recorded, to: pin });
      continue;
    }
    const trees = input.remoteTrees.get(entry.sourceUrl);
    if (!trees) {
      // The source could not be reached at all. Saying "current" here would be
      // a claim we did not verify, so it gets its own state.
      plan.unknown.push({ name: entry.name, source: entry.source });
      continue;
    }
    const remote = trees.get(entry.path) ?? null;
    if (remote === null) {
      plan.gone.push({ name: entry.name, source: entry.source, path: entry.path });
      continue;
    }
    if (remote === entry.hash) {
      plan.current.push({ name: entry.name, source: entry.source });
      continue;
    }
    // A missing hash lands here too, as `from: null`. We cannot verify what is
    // installed, and re-fetching is exactly what repairs that.
    plan.outdated.push({ name: entry.name, source: entry.source, from: entry.hash, to: remote });
  }
  return input.pins ? { ...plan, offPin } : plan;
}

// Every SKILL.md in a source repo, reduced to the skills it would install as.
// A skill's installed name is its folder name, so the mapping is structural —
// but two shapes have to be rejected first.
export function upstreamSkills(skillPaths: ReadonlyArray<string>): { path: string; name: string }[] {
  const folders = skillPaths
    .map((p) => skillFolder(p))
    // A repo-root SKILL.md makes the repo itself one skill, taking its name
    // from the repo rather than the path. Nothing here can derive that, so it
    // is skipped rather than guessed at.
    .filter((dir) => dir !== '.')
    // Shallowest first, so the nesting check below always sees a parent before
    // any of its children.
    .sort((a, b) => a.split('/').length - b.split('/').length || byCodePoint(a, b));

  const kept: string[] = [];
  for (const dir of folders) {
    // A SKILL.md beneath a folder that already holds one is a sub-resource.
    // The trailing slash matters: `s/tdd-extra` must not read as nested under
    // `s/tdd`.
    if (kept.some((k) => dir.startsWith(`${k}/`))) continue;
    kept.push(dir);
  }

  return kept.map((path) => ({ path, name: basename(path) })).sort((a, b) => byCodePoint(a.name, b.name));
}

// Upstream skills that are not installed here. Not a state of an installed
// skill — which is why it is computed separately from planUpdates rather than
// being a sixth bucket in it.
export function availableSkills(input: {
  upstreamBySource: Map<string, ReadonlyArray<{ name: string }>>;
  installed: ReadonlyArray<string>;
}): { name: string; source: string }[] {
  const installed = new Set(input.installed);
  const seen = new Set<string>();
  const out: { name: string; source: string }[] = [];
  for (const [source, skills] of input.upstreamBySource) {
    for (const { name } of skills) {
      // Two sources can offer the same name, but only one folder can ever
      // exist under ~/.agents/skills, so the first source wins and the
      // duplicate is not offered twice.
      if (installed.has(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, source });
    }
  }
  return out.sort((a, b) => byCodePoint(a.name, b.name));
}

const lsTree = (dir: string): Command => ({ cmd: 'git', args: ['ls-tree', '-r', '-t', '-z', 'HEAD'], cwd: dir, output: 'capture' });

// One shallow, blob-less clone per source answers both questions: each known folder's tree SHA, and
// (unless the source is exact) every SKILL.md it offers. ls-tree is silent about missing paths, so a
// skill gone upstream reads as null without git complaining on the terminal. null: not reachable.
export const inspectSource = (sourceUrl: string, paths: ReadonlyArray<string>, discover: boolean) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const processes = yield* Processes;
    const dir = join((yield* MachinePaths).stateRoot, 'tmp', `trees-${randomUUID()}`);
    const body = Effect.gen(function* () {
      const cloned = yield* processes.run({
        cmd: 'git', args: ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--quiet', sourceUrl, dir], output: 'capture',
      });
      if (cloned.code !== 0) return null;
      const listed = yield* processes.run(lsTree(dir));
      if (listed.code !== 0) return null;
      const treeAt = new Map<string, string>();
      const skillPaths: string[] = [];
      for (const record of listed.stdout.split('\0').filter(Boolean)) {
        // Split at the first tab only: with -z a path is not quoted and may itself hold a tab.
        const tab = record.indexOf('\t');
        const meta = record.slice(0, tab);
        const path = record.slice(tab + 1);
        const [, type, sha] = meta.split(' ');
        if (type === 'tree') treeAt.set(path, sha!);
        else if (type === 'blob' && /(^|\/)SKILL\.md$/.test(path)) skillPaths.push(path);
      }
      if (paths.includes('.')) {
        const root = yield* processes.run({ cmd: 'git', args: ['rev-parse', 'HEAD^{tree}'], cwd: dir, output: 'capture' });
        if (root.code === 0) treeAt.set('.', root.stdout.trim());
      }
      const trees = new Map(paths.map((p) => [p, treeAt.get(p) ?? null] as const));
      return { trees, skillPaths: discover ? skillPaths : [] } satisfies Upstream;
    });
    return yield* body.pipe(
      Effect.catch(() => Effect.succeed(null)),
      Effect.ensuring(fs.remove(dir).pipe(Effect.ignore)),
    );
  });

// Sources are checked one after another: each clone is a network round trip git already parallelises.
// A pinned source is never cloned: its skills are judged against the pin, and it offers nothing to adopt.
export const checkUpdates = (desired: DesiredConfig): Effect.Effect<UpdatePlan, FsFailed, Processes | Fs | MachinePaths> =>
  Effect.gen(function* () {
    const lock = yield* readSkillLock;
    const installed = yield* installedSkillNames;
    const exact = new Set(desired.skills.filter((s) => s.exact).map((s) => s.source));
    const pins = pinsBySource(desired);
    const remoteTrees = new Map<string, Map<string, string | null>>();
    const upstreamBySource = new Map<string, { path: string; name: string }[]>();
    for (const check of sourcesOf(updatableSkills(lock, installed).filter((e) => !pins.has(e.source)), exact)) {
      const found = yield* inspectSource(check.sourceUrl, check.paths, !check.exact);
      if (!found) continue;
      remoteTrees.set(check.sourceUrl, found.trees);
      upstreamBySource.set(check.source, upstreamSkills(found.skillPaths));
    }
    return { ...planUpdates({ lock, installed, remoteTrees, pins }), available: availableSkills({ upstreamBySource, installed }) };
  });

// Skills live in the shared store, so these items carry no target. `from` appears only for a skill the manifest names.
export function updateItems(plan: UpdatePlan, desired: DesiredConfig): Observed[] {
  const declared = new Map(desired.skills.map((s) => [s.name, s]));
  const item = (
    name: string, group: string, state: string, disposition: Observed['disposition'], note?: string,
  ): Observed => {
    const from = declared.get(name)?.from;
    return {
      key: `skill:${name}`, domain: 'skills', label: name, group, state, disposition,
      ...(note === undefined ? {} : { note }),
      ...(from === undefined ? {} : { from }),
    };
  };
  return [
    ...plan.current.map((s) => item(s.name, s.source, 'current', 'in-sync')),
    ...plan.outdated.map((s) => item(s.name, s.source, 'outdated', 'apply', `${short(s.from)} -> ${short(s.to)}`)),
    ...(plan.offPin ?? []).map((s) => item(s.name, s.source, 'off-pin', 'apply', offPinNote(s.from, s.to))),
    ...plan.gone.map((s) => item(s.name, s.source, 'gone', 'apply', 'gone upstream')),
    ...plan.unknown.map((s) => item(s.name, s.source, 'unknown', 'blocked', 'source unreachable')),
    ...plan.local.map((name) => item(name, '', 'local', 'excluded', 'no recorded source')),
    ...plan.available.map((s) => item(s.name, s.source, 'available', 'excluded', 'available')),
  ];
}

export const inspectUpdates = (
  desired: DesiredConfig,
): Effect.Effect<{ items: Observed[]; probeErrors: string[] }, never, Processes | Fs | MachinePaths> =>
  checkUpdates(desired).pipe(
    Effect.map((plan) => ({ items: updateItems(plan, desired), probeErrors: [] as string[] })),
    Effect.catch((error: FsFailed) =>
      Effect.succeed({ items: [] as Observed[], probeErrors: [`skills: ${error.op} ${error.path}: ${error.reason}`] }),
    ),
  );
