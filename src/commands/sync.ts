import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import {
  Backups, canonical, DecisionsStore, decisionsStore, HistoryStore, historyStore, OverridesStore, pathsFromEnvironment, StateStore,
  withApplied, type Decision, type MachinePathsValue,
} from '@nortuscc/machine';
import type { MachineOverrides } from '@nortuscc/profile-engine';
import {
  incoming, isAncestor, LOCAL_SETUP, nextHolds, revParse, SyncStore, syncStore, upstreamOf, withoutOverride,
  type Conflict, type Holds, type ItemChange,
} from '@nortuscc/sync';
import { installRuntime, RUNTIME_INSTALL } from '../../bin/launcher.mjs';
import { restartAfterPull } from '../agent-service.ts';
import { runGit } from '../git.ts';
import { CHECKOUT, cliLayer, openDesired, refuseInvalidOverrides, reportOverrideIssues, runCommand } from '../machine.ts';
import { parseConfigMode } from '../config-mode.ts';
import { parseInstallFlags } from '../install.ts';
import { formatRow, labelWidth, section, short } from '../report.ts';
import { select as realSelect, type Choice } from '../select.ts';
import { parseTarget, selectedTargets, type TargetChoice } from '../targets.ts';
import { inspectIntegrations } from './status.ts';

const USAGE = 'Usage: nortuscc sync [--check] [--yes] [--skip ID,ID] [--take-theirs ID,ID] [--release ID] [--target claude|codex|all]';
const DIVERGED = '\nnortuscc: the checkout cannot fast-forward to its upstream.\nThe remote has diverged; resolve it in the repo before applying.';

export type SyncFlags = {
  check: boolean;
  yes: boolean;
  release: string | undefined;
  skip: string[];
  takeTheirs: string[];
  // What reaches the child apply: everything but sync's own flags (--yes included, for --install).
  rest: string[];
  error: string | null;
};

// The apply flags sync forwards beyond those parseConfigMode, parseInstallFlags and parseTarget own.
const APPLY_FLAGS = ['--install', '--skills', '--take-repo'];

const LISTS = ['--release', '--skip', '--take-theirs'] as const;

export function parseSyncFlags(args: string[]): SyncFlags {
  const out: SyncFlags = { check: false, yes: false, release: undefined, skip: [], takeTheirs: [], rest: [], error: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--check') { out.check = true; continue; }
    if (arg === '--yes') { out.yes = true; out.rest.push(arg); continue; }
    const flag = LISTS.find((f) => arg === f || arg.startsWith(`${f}=`));
    if (flag === undefined) { out.rest.push(arg); continue; }
    const value = arg === flag ? args[++i] : arg.slice(flag.length + 1);
    // A following flag is a missing argument, not an item id.
    if (!value || value.startsWith('-')) return { ...out, error: `${flag} needs an item id` };
    if (flag === '--release') out.release = value;
    else (flag === '--skip' ? out.skip : out.takeTheirs).push(...value.split(',').filter(Boolean));
  }
  const both = out.skip.filter((id) => out.takeTheirs.includes(id));
  if (both.length > 0) return { ...out, error: `${[...new Set(both)].join(', ')} named in both --skip and --take-theirs` };
  // The child apply ignores what it does not know, so a typo is caught here, before the repo moves.
  const installFlags = parseInstallFlags(parseConfigMode(out.rest).rest);
  if (installFlags.error) return { ...out, error: installFlags.error };
  const unknown = installFlags.rest.find((arg) => !APPLY_FLAGS.includes(arg));
  if (unknown !== undefined) return { ...out, error: `unknown option ${unknown}` };
  if (out.check && (out.release !== undefined || out.skip.length > 0 || out.takeTheirs.length > 0)) {
    return { ...out, error: '--check reports only; it takes no --release, --skip or --take-theirs' };
  }
  if (out.release !== undefined && (out.skip.length > 0 || out.takeTheirs.length > 0)) {
    return { ...out, error: '--release takes no --skip or --take-theirs' };
  }
  return out;
}

const shown = (change: ItemChange, value: string | undefined): string =>
  value === undefined ? '(absent)'
    : change.kind === 'file' ? value.slice(0, 'sha256:'.length + 7)
    : value.length > 40 ? `${value.slice(0, 39)}…` : value;

// One row per incoming item with old → new, then the conflicts with this machine's overrides.
export function previewLines(changes: ReadonlyArray<ItemChange>, conflicts: ReadonlyArray<Conflict>): string[] {
  if (changes.length === 0) return [formatRow('setup', 'current', 'nothing new since the last sync')];
  const width = labelWidth(changes.map((c) => c.itemId));
  const state = (c: ItemChange) => (c.before === undefined ? 'added' : c.after === undefined ? 'removed' : 'changed');
  const lines = changes.map((c) => formatRow(c.itemId, state(c), `${shown(c, c.before)} → ${shown(c, c.after)}`, width));
  if (conflicts.length > 0) {
    lines.push('', "  conflicts with this machine's overrides (your override stays unless you take theirs):");
    lines.push(...conflicts.map((c) => formatRow(c.itemId, 'conflict', `overridden by ${c.override}`, width)));
  }
  return lines;
}

// The picker's rows. Skipping is opt-in: every item is ticked unless --skip names it or it was
// skipped at this head before; every conflict keeps the override unless --take-theirs names it.
export function choiceRows(
  changes: ReadonlyArray<ItemChange>,
  conflicts: ReadonlyArray<Conflict>,
  decisions: ReadonlyArray<Decision>,
  head: string,
  flags: Pick<SyncFlags, 'skip' | 'takeTheirs'>,
): Choice[] {
  const skippedHere = new Set(decisions
    .filter((d) => d.setupId === LOCAL_SETUP && d.commit === head && d.decision === 'skip')
    .map((d) => d.itemId));
  return [
    ...changes.map((c): Choice => ({
      key: `item:${c.itemId}`, group: 'take from the setup', label: c.itemId, note: `${shown(c, c.before)} → ${shown(c, c.after)}`,
      checked: !flags.skip.includes(c.itemId) && !skippedHere.has(c.itemId),
    })),
    ...conflicts.map((c): Choice => ({
      key: `theirs:${c.itemId}`, group: 'take theirs (drops your override)', label: c.itemId, note: `overridden by ${c.override}`,
      checked: flags.takeTheirs.includes(c.itemId),
    })),
  ];
}

export type Chosen = { readonly accepted: ReadonlySet<string>; readonly takeTheirs: ReadonlySet<string> };

// Taking theirs also accepts the item.
export function chosenFrom(keys: ReadonlyArray<string>): Chosen {
  const takeTheirs = new Set(keys.filter((k) => k.startsWith('theirs:')).map((k) => k.slice('theirs:'.length)));
  const accepted = new Set([...keys.filter((k) => k.startsWith('item:')).map((k) => k.slice('item:'.length)), ...takeTheirs]);
  return { accepted, takeTheirs };
}

// The lockfile's content hash, or null when there is none.
function lockfileHash(repo: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(join(repo, 'package-lock.json'))).digest('hex');
  } catch {
    return null;
  }
}

// A child process, because the modules this process loaded are the pre-pull ones: a fresh process
// reads the pulled code (and dependencies) from disk. It composes held items itself.
function applyChild(target: TargetChoice, rest: ReadonlyArray<string>): number {
  const applied = spawnSync(process.execPath, [join(CHECKOUT, 'bin', 'nortuscc.mjs'), 'apply', '--target', target, ...rest], {
    stdio: 'inherit', env: process.env,
  });
  if (applied.error) {
    console.error(`nortuscc: could not run apply: ${applied.error.message}`);
    return 1;
  }
  return applied.status ?? 128 + (applied.signal ? constants.signals[applied.signal] : 0);
}

const decide = (itemId: string, head: string, decision: 'accept' | 'skip', decidedAt: string) =>
  Effect.gen(function* () {
    const record: Decision = { setupId: LOCAL_SETUP, itemId, revision: null, commit: head, decision, decidedAt, machineId: null, source: 'local' };
    if (yield* (yield* DecisionsStore).record(record)) {
      yield* (yield* HistoryStore).append({ kind: 'decided', actor: 'cli', setupId: LOCAL_SETUP, itemId, revision: null, commit: head, decision });
    }
  });

// Step 7: decisions, holds, and taken overrides (overrides.json backed up first).
const record = (input: {
  readonly changes: ReadonlyArray<ItemChange>;
  readonly chosen: Chosen;
  readonly holds: Holds;
  readonly applied: string;
  readonly head: string;
  readonly overrides: MachineOverrides;
  readonly stateRoot: string;
}) =>
  Effect.gen(function* () {
    const decidedAt = new Date().toISOString();
    for (const change of input.changes) {
      yield* decide(change.itemId, input.head, input.chosen.accepted.has(change.itemId) ? 'accept' : 'skip', decidedAt);
    }
    const next = nextHolds({ holds: input.holds, changes: input.changes, accepted: input.chosen.accepted, applied: input.applied });
    if (canonical(next) !== canonical(input.holds)) yield* (yield* SyncStore).write(next);
    if (input.chosen.takeTheirs.size === 0) return;
    const backups = yield* Backups;
    yield* backups.preserve(join(input.stateRoot, 'overrides.json'), 'overrides.json');
    let value = input.overrides;
    for (const itemId of input.chosen.takeTheirs) value = withoutOverride(value, itemId);
    yield* (yield* OverridesStore).write(value);
    const dir = yield* backups.dir;
    process.stdout.write(`\noverrides.json: took the setup's value for ${[...input.chosen.takeTheirs].join(', ')}`
      + `${dir ? `; the previous file is in ${dir}` : ''}\n`);
  });

// A pull can bring down a newly declared integration. It is reported, never installed: a
// fast-forward must not turn into an unattended run of third-party installers. With --install,
// apply already ran the install workflow.
const reportIntegrations = (target: TargetChoice, rest: ReadonlyArray<string>) =>
  Effect.scoped(Effect.gen(function* () {
    if (rest.includes('--install')) return 0;
    const opened = yield* openDesired();
    const { manifestErrors, planned } = yield* inspectIntegrations(opened, selectedTargets(target)).pipe(Effect.provide(opened.layer));
    if (manifestErrors.length) {
      process.stdout.write('\n' + section('integrations', manifestErrors.map((m) => formatRow('manifest', 'invalid', m))));
      return 0;
    }
    const unresolved = planned.filter((i) => i.state !== 'installed');
    if (unresolved.length) {
      process.stdout.write('\n' + section('integrations', [
        ...unresolved.map((i) => formatRow(i.label, i.state, i.note ?? '')),
        // Unknown means the agent's CLI could not answer; installing cannot fix that.
        ...(unresolved.some((i) => i.state !== 'unknown') ? ['', '  nortuscc apply --install'] : []),
      ]));
    }
    return 0;
  }));

// `--release <itemId>`: drops one hold without fetching, records the accept, then applies.
const release = (repo: string, holds: Holds, itemId: string, target: TargetChoice, rest: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (!Object.hasOwn(holds, itemId)) {
      console.error(`nortuscc: ${itemId} is not held (held: ${Object.keys(holds).sort().join(', ') || 'nothing'})`);
      return 2;
    }
    const head = yield* revParse(repo, 'HEAD');
    if (head !== undefined) yield* decide(itemId, head, 'accept', new Date().toISOString());
    const { [itemId]: _released, ...remaining } = holds;
    yield* (yield* SyncStore).write(remaining);
    process.stdout.write('\n' + section('sync', [formatRow(itemId, 'released', "takes the checkout's value")]));
    return applyChild(target, rest);
  });

export type SyncDeps = { readonly select: typeof realSelect; readonly isTTY: boolean };

const syncMachine = (paths: MachinePathsValue, target: TargetChoice, flags: SyncFlags, deps: SyncDeps) =>
  Effect.gen(function* () {
    const repo = paths.repo;
    // 1. Refuse on what a person must fix by hand, before the repo moves.
    const overrides = yield* (yield* OverridesStore).read;
    reportOverrideIssues(overrides);
    if (refuseInvalidOverrides(overrides)) return 1;
    const holds = yield* (yield* SyncStore).read;
    const decisions = yield* (yield* DecisionsStore).read;
    if (flags.release !== undefined) return yield* release(repo, holds, flags.release, target, flags.rest);

    // 2. Fetch the tracked branch's ref; a checkout without one, or diverged from it, is left alone.
    const upstream = yield* upstreamOf(repo);
    if (upstream === undefined) {
      console.error('\nnortuscc: this checkout tracks no upstream branch, so there is nothing to sync from.');
      return 1;
    }
    if (runGit(repo, ['fetch', '--quiet', '--no-tags', upstream.remote, `+refs/heads/${upstream.branch}:${upstream.ref}`]).code !== 0) {
      console.error(`\nnortuscc: could not fetch ${upstream.remote}/${upstream.branch}; nothing was changed.`);
      return 1;
    }
    const before = yield* revParse(repo, 'HEAD');
    const fetched = yield* revParse(repo, upstream.ref);
    if (before === undefined || fetched === undefined) {
      console.error(`\nnortuscc: could not read HEAD or ${upstream.ref}; nothing was changed.`);
      return 1;
    }
    const behind = (yield* isAncestor(repo, before, fetched)) === true;
    const ahead = !behind && (yield* isAncestor(repo, fetched, before)) === true;
    if (!behind && !ahead) {
      console.error(DIVERGED);
      return 1;
    }
    const head = behind ? fetched : before;

    // 3. What changed since the applied commit, measured from this machine's holds.
    const recorded = (yield* (yield* StateStore).read).applied?.commit;
    const known = recorded === undefined ? undefined : yield* revParse(repo, recorded);
    if (recorded !== undefined && known === undefined) {
      console.error(`nortuscc: the applied commit ${short(recorded)} is not in this checkout; measuring from ${short(before)}`);
    }
    const applied = known ?? before;
    const { changes, conflicts } = yield* incoming({ repo, applied, head, holds, overrides: overrides.value });

    // 4. Report; --check stops here.
    process.stdout.write('\n' + section('sync', previewLines(changes, conflicts)));
    if (flags.check) return changes.length > 0 ? 1 : 0;

    // 5. Choose. A named id that is not waiting is a typo: nothing is accepted on its account.
    const notWaiting = [...flags.skip, ...flags.takeTheirs].filter((id) => !changes.some((c) => c.itemId === id));
    const noOverride = flags.takeTheirs.filter((id) => changes.some((c) => c.itemId === id) && !conflicts.some((c) => c.itemId === id));
    if (notWaiting.length > 0 || noOverride.length > 0) {
      for (const id of notWaiting) console.error(`nortuscc: ${id} is not waiting`);
      for (const id of noOverride) console.error(`nortuscc: ${id} has no override to take theirs over`);
      return 2;
    }
    const rows = choiceRows(changes, conflicts, decisions, head, flags);
    const picked = flags.yes || !deps.isTTY || rows.length === 0
      ? rows.filter((r) => r.checked).map((r) => r.key)
      : yield* Effect.promise(() => deps.select(rows, { title: 'choose what to take from the setup', isTTY: deps.isTTY }));
    if (picked === null) {
      process.stdout.write('\ncancelled; nothing was changed\n');
      return 1;
    }
    const chosen = chosenFrom(picked);

    // 6. Fast-forward, reinstalling the runtime when the lockfile moved.
    if (head !== before) {
      const lock = lockfileHash(repo);
      if (runGit(repo, ['merge', '--ff-only', '--quiet', head]).code !== 0) {
        console.error('\nnortuscc: git merge --ff-only failed; commit or discard the local edits it names, then re-run.');
        return 1;
      }
      if (lockfileHash(repo) !== lock) {
        // In the tree whose lockfile changed; in normal use the recorded repo is this checkout.
        console.error('nortuscc: package-lock.json changed; reinstalling runtime dependencies');
        const failure = installRuntime(repo);
        if (failure) {
          console.error(`nortuscc: could not install dependencies (${failure}); run 'npm ${RUNTIME_INSTALL.join(' ')}' in ${repo}`);
          return 1;
        }
      }
    }

    // 7. Record decisions and holds; take theirs.
    yield* record({ changes, chosen, holds, applied, head, overrides: overrides.value, stateRoot: paths.stateRoot });

    // 8. Apply through the pulled code; 9. on success, record the applied commit.
    const code = applyChild(target, flags.rest);
    if (code !== 0) return code;
    yield* (yield* StateStore).update((state) => withApplied(state, head));
    // The agent runs from this checkout and never downloads code; whoever installed it upgrades it
    // (ADR 0011), so a pull that moved the checkout restarts a CLI-installed agent on the new code.
    if (head !== before) yield* restartAfterPull(paths);
    return yield* reportIntegrations(target, flags.rest);
  });

// `nortuscc sync` (and `nortuscc pull`): fetch the tracked branch, preview what changed item by item,
// record what the person takes (overrides stay unless they take theirs), fast-forward, apply, and
// record the applied commit. Non-interactive (--yes or no terminal) it takes every item and keeps
// every override, as pull always did. `deps` replaces the picker and the terminal check in tests.
export async function run(args: string[] = [], deps: SyncDeps = { select: realSelect, isTTY: Boolean(process.stdin.isTTY) }): Promise<number> {
  // Validated before anything moves: a bad target or flag exits 2 with the repo untouched.
  const { target, rest, error } = parseTarget(args);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }
  const flags = parseSyncFlags(rest);
  if (flags.error) {
    console.error(`nortuscc: ${flags.error}`);
    console.error(USAGE);
    return 2;
  }
  return runCommand(() => Effect.gen(function* () {
    const paths = yield* pathsFromEnvironment({
      env: process.env, home: homedir(), platform: process.platform, fallbackRepo: CHECKOUT, warn: (m) => console.error(m),
    });
    const layer = Layer.mergeAll(syncStore, decisionsStore, historyStore()).pipe(Layer.provideMerge(cliLayer(paths)));
    return yield* syncMachine(paths, target, flags, deps).pipe(Effect.provide(layer));
  }));
}
