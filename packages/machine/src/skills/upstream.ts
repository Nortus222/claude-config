import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { Effect } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import type { FsFailed } from '../errors.ts';
import { Fs } from '../fs.ts';
import type { Observed } from '../model.ts';
import { MachinePaths } from '../paths.ts';
import { boundedNetworkGit, STALL_LIMIT_ARGS } from '../network-git.ts';
import { Processes, type Command } from '../processes.ts';
import { readSkillCandidates, type SkillCandidate, type SkillCandidatesResult } from './candidates.ts';
import type { SkillLock } from './manifest.ts';
import { lockRef, offPinNote, pinsBySource, short } from './pins.ts';
import { additionLockEntry, installedSkillNames, readSkillLockEvidence } from './store.ts';

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
export function updatableSkills(lock: SkillLock, installed: ReadonlyArray<string>, additions?: ReadonlySet<string>): UpdatableSkill[] {
  const skills = isRecord(lock) && isRecord(lock.skills) ? lock.skills : {};
  const entries: UpdatableSkill[] = [];
  for (const name of installed) {
    const meta = additions?.has(name) ? additionLockEntry(lock, name)?.meta : skills[name];
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

export type UpdateSourceFailure = { readonly source: string } & Extract<SkillCandidatesResult,{ readonly ok:false }>;

export type UpdatePlan = {
  readonly sourceFailures?: readonly UpdateSourceFailure[];
  current: { name: string; source: string }[];
  outdated: { name: string; source: string; from: string | null; to: string }[];
  gone: { name: string; source: string; path: string }[];
  unknown: { name: string; source: string }[];
  local: string[];
  available: { name: string; source: string; tree?: string; adoption?: Pick<SkillCandidate,'source' | 'revision' | 'sourceDir' | 'selectorName' | 'installedName' | 'blob' | 'tree'> }[];
  // Skills whose lock ref disagrees with the pin: a pinned skill at another ref (or none), or an unpinned
  // skill still at a ref (`to: null`). Present when planUpdates was given pins or found such a skill.
  offPin?: { name: string; source: string; from: string | null; to: string | null }[];
};

// A skill whose lock source is pinned is judged by its recorded ref against the pin, never against
// upstream HEAD, so it needs no remote tree and is never `unknown`. An unpinned skill whose lock still
// records a ref is off-pin too: `update` would reinstall that ref forever, so only a ref-less `add` repairs it.
export function planUpdates(input: {
  lock: SkillLock;
  installed: ReadonlyArray<string>;
  remoteTrees: Map<string, Map<string, string | null>>;
  pins?: ReadonlyMap<string, string>;
  additions?: ReadonlySet<string>;
}): Omit<UpdatePlan, 'available'> {
  const names = [...input.installed].sort();
  const entries = updatableSkills(input.lock, names, input.additions);
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
      const recorded = lockRef(input.additions?.has(entry.name) ? additionLockEntry(input.lock, entry.name)?.meta : input.lock.skills[entry.name]);
      if (recorded === pin) plan.current.push({ name: entry.name, source: entry.source });
      else offPin.push({ name: entry.name, source: entry.source, from: recorded, to: pin });
      continue;
    }
    const stuck = lockRef(input.additions?.has(entry.name) ? additionLockEntry(input.lock, entry.name)?.meta : input.lock.skills[entry.name]);
    if (stuck !== null && !input.additions?.has(entry.name)) {
      offPin.push({ name: entry.name, source: entry.source, from: stuck, to: null });
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
  return input.pins || offPin.length ? { ...plan, offPin } : plan;
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
// skill gone upstream reads as null without git complaining on the terminal. null: not reachable,
// including a clone that runs past `timeoutMs` and is killed. The clone runs unattended.
export const inspectSource = (sourceUrl: string, paths: ReadonlyArray<string>, discover: boolean, options: { readonly timeoutMs?: number } = {}) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const processes = yield* Processes;
    const dir = join((yield* MachinePaths).stateRoot, 'tmp', `trees-${randomUUID()}`);
    const body = Effect.gen(function* () {
      const failure = yield* boundedNetworkGit('git clone', processes.run({
        cmd: 'git', args: ['-c', 'credential.interactive=never', ...STALL_LIMIT_ARGS, 'clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--quiet', sourceUrl, dir],
        env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }, output: 'capture', stderr: 'capture',
      }), options.timeoutMs);
      if (failure !== undefined) return null;
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
      const trees = new Map<string,string | null>(treeAt);
      for (const path of paths) if (!trees.has(path)) trees.set(path, null);
      return { trees, skillPaths: discover ? skillPaths : [] } satisfies Upstream;
    });
    return yield* body.pipe(
      Effect.catch(() => Effect.succeed(null)),
      Effect.ensuring(fs.remove(dir).pipe(Effect.ignore)),
    );
  });

// Sources are checked one after another: each clone is a network round trip git already parallelises.
// A pinned source is never cloned: its skills are judged against the pin, and it offers nothing to adopt.
export const checkUpdates = (desired: DesiredConfig, options?: { readonly maxSources?: number; readonly verifyAdoption?: boolean }): Effect.Effect<UpdatePlan, FsFailed, Processes | Fs | MachinePaths> =>
  Effect.gen(function* () {
    const { lock } = yield* readSkillLockEvidence;
    const installed = yield* installedSkillNames;
    const exact = new Set(desired.skills.filter(s => s.exact && s.declaredFrom?.layer !== 'machine').map(s => s.source));
    for (const skill of desired.skills) if (skill.declaredFrom?.layer === 'machine' && !desired.skills.some(s => s.source === skill.source && s.declaredFrom?.layer !== 'machine')) exact.add(skill.source);
    const additions = new Set(desired.skills.filter(s => s.targets !== undefined).map(s => s.name));
    const pins = pinsBySource(desired);
    const remoteTrees = new Map<string, Map<string, string | null>>();
    const upstreamBySource = new Map<string, { path: string; name: string }[]>();
    for (const check of sourcesOf(updatableSkills(lock, installed, additions).filter((e) => !pins.has(e.source)), exact).slice(0,options?.maxSources)) {
      const found = yield* inspectSource(check.sourceUrl, check.paths, !check.exact);
      if (!found) continue;
      remoteTrees.set(check.sourceUrl, found.trees);
      upstreamBySource.set(check.source, upstreamSkills(found.skillPaths));
    }
    const available: UpdatePlan['available'] = [];
    const candidates = new Map<string, readonly SkillCandidate[]>();
    const sourceFailures: UpdateSourceFailure[] = [];
    for (const skill of availableSkills({ upstreamBySource, installed })) {
      const path = upstreamBySource.get(skill.source)?.find(s => s.name === skill.name)?.path;
      const check = sourcesOf(updatableSkills(lock, installed, additions), exact).find(s => s.source === skill.source);
      const tree = path && check ? remoteTrees.get(check.sourceUrl)?.get(path) : undefined;
      if (options?.verifyAdoption && !candidates.has(skill.source)) {
        const found = yield* readSkillCandidates({ source: skill.source });
        candidates.set(skill.source,found.ok ? found.candidates : []);
        if (!found.ok) sourceFailures.push({ ...found,source:skill.source });
      }
      const exactCandidate = candidates.get(skill.source)?.find(candidate => candidate.sourceDir === path
        && candidate.tree === tree && candidate.selectorName === skill.name && candidate.installedName === skill.name);
      const adoption = exactCandidate && { source:exactCandidate.source,revision:exactCandidate.revision,sourceDir:exactCandidate.sourceDir,
        selectorName:exactCandidate.selectorName,installedName:exactCandidate.installedName,blob:exactCandidate.blob,tree:exactCandidate.tree };
      available.push({ ...skill, ...(tree ? { tree } : {}), ...(adoption ? { adoption } : {}) });
    }
    return { ...planUpdates({ lock, installed, remoteTrees, pins, additions }), available, ...(sourceFailures.length ? { sourceFailures } : {}) };
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
    ...plan.outdated.map((s) => ({ ...item(s.name, s.source, 'outdated', 'apply', `${short(s.from)} -> ${short(s.to)}`), facts: [`offered-tree:${s.to}`] })),
    ...(plan.offPin ?? []).map((s) => item(s.name, s.source, 'off-pin', 'apply', offPinNote(s.from, s.to))),
    ...plan.gone.map((s) => item(s.name, s.source, 'gone', 'apply', 'gone upstream')),
    ...plan.unknown.map((s) => item(s.name, s.source, 'unknown', 'blocked', 'source unreachable')),
    ...plan.local.map((name) => item(name, '', 'local', 'excluded', 'no recorded source')),
    ...plan.available.map((s) => ({ ...item(s.name, s.source, 'available', 'excluded', 'available'), ...((s.tree || s.adoption) ? { facts: [...(s.tree ? [`offered-tree:${s.tree}`] : []), ...(s.adoption ? [`native-adoption:${JSON.stringify(s.adoption)}`] : [])] } : {}) })),
  ];
}

export const inspectUpdates = (
  desired: DesiredConfig, options?: { readonly maxSources?: number; readonly verifyAdoption?: boolean },
): Effect.Effect<{ items: Observed[]; probeErrors: string[]; sourceFailures?: readonly UpdateSourceFailure[] }, never, Processes | Fs | MachinePaths> =>
  checkUpdates(desired, options).pipe(
    Effect.map((plan) => ({ items: updateItems(plan, desired),
      probeErrors: plan.sourceFailures?.some(failure => failure.reason === 'cleanup-failed' || failure.retainedDirectory) ? ['Skill source cleanup is unconfirmed; updates are unavailable until source ownership is inspected'] : [],
      ...(plan.sourceFailures ? { sourceFailures:plan.sourceFailures } : {}),
    })),
    Effect.catch((error: FsFailed) =>
      Effect.succeed({ items: [] as Observed[], probeErrors: [`skills: ${error.op} ${error.path}: ${error.reason}`] }),
    ),
  );

// The source owner proves native selector, destination and offered content together before legacy adoption.
export const hasVerifiedAdoption = (item: Observed): boolean => {
  const fact = item.facts?.find(fact => fact.startsWith('native-adoption:'));
  if (!fact) return false;
  try {
    const evidence = JSON.parse(fact.slice('native-adoption:'.length));
    return evidence.source === item.group && evidence.selectorName === item.label && evidence.installedName === item.label
      && /^[a-f0-9]{40}$/.test(evidence.revision) && /^[a-f0-9]{40}$/.test(evidence.blob)
      && item.facts!.includes(`offered-tree:${evidence.tree}`);
  } catch { return false; }
};
