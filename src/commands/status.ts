import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Effect } from 'effect';
import type { DesiredConfig, ResolvedFile, Target } from '@nortuscc/profile-engine';
import {
  configFileId, hookCommand, inspect, knownMarketplaces, probeUndeclared, readCodexState, readExposure, SKILL_AGENTS,
  skillExposure, userScopeInstalls, type InstalledIntegrations, type Observed,
} from '@nortuscc/machine';
import { cliVersion, type CliVersion } from '../cli-version.ts';
import { parseConfigMode, resolveConfigMode, SKIPPED_LABEL, SKIPPED_NOTE, SKIPPED_STATE } from '../config-mode.ts';
import { CHECKOUT, domainsFor, forTargets, openMachine, runCommand, type CliServices, type CodexStateRead, type Opened } from '../machine.ts';
import { confirm as realConfirm } from '../prompt.ts';
import { formatRow, labelWidth, section } from '../report.ts';
import { parseTarget, selectedTargets, type TargetChoice } from '../targets.ts';

// `nortuscc status`: read-only by construction. It writes no state, overrides or backups; the one
// thing it can change is nortuscc itself, and only after an explicit yes.

export type StatusDeps = {
  cliState?: (root: string) => CliVersion;
  confirm?: (question: string, options: { isTTY?: boolean }) => Promise<boolean | null>;
  // Updates the repo at `repo` (and the CLI, when they are the same checkout); returns the exit code.
  pull?: (repo: string, target: TargetChoice) => Promise<number>;
  isTTY?: boolean;
};

// Config states that need a command to resolve them.
const NEEDS_APPLY = new Set(['repo-ahead', 'unmanaged', 'missing']);
const NEEDS_CAPTURE = new Set(['local-ahead']);
const BLOCKED = new Set(['conflict', 'missing-repo', 'unknown-mode', 'unparseable-local', 'invalid']);

type ConfigRow = { dest: string; state: string; note?: string };

// Runs this checkout's CLI in a child, so the update never runs on the modules this process loaded.
// The child resolves the same repo from the inherited environment; in normal use it is this checkout.
const spawnPull = (_repo: string, target: TargetChoice): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(CHECKOUT, 'bin', 'nortuscc.mjs'), 'pull', '--target', target], { stdio: 'inherit', env: process.env });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

function noteFor(state: string): string {
  switch (state) {
    case 'conflict': return 'changed in the repo AND here';
    case 'local-ahead': return 'local edits not in the repo';
    case 'repo-ahead': return 'repo has newer content';
    case 'unmanaged': return 'never synced on this machine';
    case 'missing-repo': return 'listed in the manifest but absent from the repo';
    case 'unknown-mode': return 'manifest entry has an unrecognized mode';
    case 'unparseable-local': return 'the local file could not be parsed';
    default: return '';
  }
}

function suggestions(rows: ReadonlyArray<ConfigRow>): string {
  const out: string[] = [];
  if (rows.some((r) => NEEDS_APPLY.has(r.state))) out.push('  nortuscc apply     bring this machine up to date');
  if (rows.some((r) => NEEDS_CAPTURE.has(r.state))) out.push('  nortuscc push -m   share local edits');
  if (rows.some((r) => r.state === 'conflict')) {
    // Each command accepts only the flag matching its own direction.
    out.push('  conflicts need a decision:');
    out.push('    nortuscc apply --take-repo    discard the local version');
    out.push('    nortuscc capture --take-local keep the local version');
  }
  return out.join('\n');
}

// One file's report rows. A settings document collapses to one row while every owned key agrees,
// and otherwise lists only the keys that do not; a refused repo document lists its complaints.
function fileRows(file: ResolvedFile, items: ReadonlyArray<Observed>, desired: DesiredConfig): ConfigRow[] {
  const mine = items.filter((i) => configFileId(i.key) === file.id);
  if (mine.length === 0) return [];
  const whole = mine.length === 1 && mine[0]!.key === `config:${file.id}`;
  if (whole && mine[0]!.state === 'invalid') {
    return desired.issues
      .filter((i) => i.layer === 'base' && i.source === file.src)
      .map((i) => ({ dest: 'manifest', state: 'invalid', note: i.message }));
  }
  if (whole) return [{ dest: file.dest, state: mine[0]!.state }];
  const states = new Set(mine.map((i) => i.state));
  if (states.size === 1) return [{ dest: file.dest, state: [...states][0]! }];
  return mine.filter((i) => i.state !== 'clean').map((i) => ({ dest: i.label, state: i.state }));
}

// The selected agents' declared integrations and their observed states; nothing is inspected when
// integrations.json is invalid, and its complaints are returned instead.
export function inspectIntegrations(opened: Opened, targets: ReadonlyArray<Target>, codexState?: CodexStateRead): Effect.Effect<{
  selected: DesiredConfig; manifestErrors: string[]; planned: ReadonlyArray<Observed>;
}, unknown, CliServices> {
  return Effect.gen(function* () {
    const selected = forTargets(opened.desired, targets);
    const manifestErrors = opened.desired.issues.filter((i) => i.source === 'integrations.json').map((i) => i.message);
    const planned = manifestErrors.length ? [] : (yield* inspect(selected, [domainsFor(opened.paths, { codexState }).integrations])).items;
    return { selected, manifestErrors, planned };
  });
}

// The cli, config, integrations, skills and undeclared sections, then advice. Returns 1 when the
// machine is out of agreement (or, with --strict, has undeclared findings), else 0.
function report(opened: Opened, input: {
  target: TargetChoice; rest: string[]; mode: ReturnType<typeof parseConfigMode>; deps: StatusDeps;
}): Effect.Effect<number, unknown, CliServices> {
  return Effect.gen(function* () {
    const { paths, desired } = opened;
    const { target, rest, deps } = input;
    const targets = selectedTargets(target);
    const domains = domainsFor(paths);

    // First: everything below is computed by this checkout's code, so a stale checkout reports stale.
    const cli = (deps.cliState ?? ((root) => cliVersion({ root })))(paths.repo);
    if (cli.state === 'behind' || cli.state === 'unknown') {
      const row = cli.state === 'behind'
        ? formatRow('nortuscc', 'behind', `${cli.remote}/${cli.branch} is at ${cli.sha}`)
        : formatRow('nortuscc', 'unknown', cli.note);
      process.stdout.write('\n' + section('cli', [row]));
    }
    if (cli.state === 'behind') {
      // Never asked where nothing can answer: without a terminal this reports and exits non-zero.
      const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
      const update = isTTY ? yield* Effect.promise(() => (deps.confirm ?? realConfirm)('Update nortuscc now?', { isTTY })) : false;
      if (update) {
        const code = yield* Effect.promise(() => (deps.pull ?? spawnPull)(paths.repo, target));
        if (code !== 0) return code;
        // No report from the modules this process already loaded: they are the old ones.
        process.stdout.write('\nnortuscc updated. Re-run `nortuscc status` to report on the new version.\n');
        return 0;
      }
    }

    // config. A skills-only machine reports the section as skipped: silence would read as clean.
    const { manageConfig, configTargets } = resolveConfigMode(input.mode, opened.overrides.value);
    const rows: ConfigRow[] = [];
    let configErrors: ReadonlyArray<string> = [];
    if (manageConfig) {
      const inspected = yield* inspect(desired, [domains.config]);
      configErrors = inspected.probeErrors;
      const files = desired.files.filter((f) => targets.includes(f.target) && configTargets.includes(f.target));
      for (const file of files) rows.push(...fileRows(file, inspected.items, desired));
    }
    for (const error of configErrors) console.error(`nortuscc: ${error}`);
    const width = labelWidth(rows.map((r) => r.dest));
    const configLines = manageConfig
      ? rows.map((r) => formatRow(r.dest, r.state, r.note ?? noteFor(r.state), width))
      : [formatRow(SKIPPED_LABEL, SKIPPED_STATE, SKIPPED_NOTE)];
    if (manageConfig) {
      for (const agent of targets) {
        if (!configTargets.includes(agent)) configLines.push(formatRow(`${agent} configuration`, 'unmanaged', 'not selected on this machine'));
      }
    }
    process.stdout.write('\n' + section('config', configLines));

    // integrations: inspected, never installed. Unknown means the agent's CLI could not answer, which
    // re-running apply cannot repair, so it is reported without being called pending. Blocked is
    // pending but not installable: apply skips it, and its note names the fix.
    // Codex's plugin list carries its whole remote catalog, so inspect and the probe below share one read.
    const codexState = yield* Effect.cached(readCodexState);
    const { selected, manifestErrors, planned } = yield* inspectIntegrations(opened, targets, codexState);
    const unresolved = planned.filter((i) => i.state !== 'installed');
    const pending = unresolved.filter((i) => i.state !== 'unknown');
    const installable = pending.filter((i) => i.state !== 'blocked');

    // Claude-side state files and the Codex CLI, read for the undeclared probe and --versions.
    const installed: InstalledIntegrations[] = [];
    const versions = new Map<string, string | null>();
    const codexErrors: string[] = [];
    if (targets.includes('claude')) {
      const installs = yield* userScopeInstalls(paths.claude);
      for (const { name, version } of installs) versions.set(name, version);
      const marketplaces = Object.keys(yield* knownMarketplaces(paths.claude));
      installed.push({ target: 'claude', plugins: installs.map((p) => p.name), marketplaces });
    }
    if (targets.includes('codex')) {
      const codex = yield* codexState;
      codexErrors.push(...[codex.pluginError, codex.marketplaceError].filter((e): e is string => Boolean(e)));
      // Codex reports no versions through its CLI.
      for (const name of codex.plugins) versions.set(name, null);
      installed.push({ target: 'codex', plugins: [...codex.plugins], marketplaces: [...codex.marketplaces] });
    }

    // --versions swaps the note column for a version; it never replaces the pending list or its hint.
    const showVersions = rest.includes('--versions');
    const integrationNote = (item: Observed) =>
      item.state === 'unknown'
        ? (item.note ?? '')
        : showVersions && isPlugin(selected, item)
          ? (versions.get(pluginOf(selected, item)) ?? 'unknown')
          : (item.note ?? '');
    const integrationRow = (item: Observed) => formatRow(item.label, item.state, integrationNote(item));
    const integrationLines = manifestErrors.length
      ? manifestErrors.map((message) => formatRow('manifest', 'invalid', message))
      : planned.length === 0
        ? [formatRow('none declared', 'satisfied', '')]
        : unresolved.length === 0
          ? showVersions ? planned.map(integrationRow) : [formatRow('all declared', 'installed', '')]
          : [
            ...(showVersions ? planned : unresolved).map(integrationRow),
            ...(installable.length ? ['', '  nortuscc apply --install'] : []),
          ];
    process.stdout.write(section('integrations', integrationLines));

    // skills: the store's own answer, then whether each selected agent can load what it holds.
    const skills = yield* inspect(desired, [domains.skills]);
    const named = (pick: (i: Observed) => boolean) => skills.items.filter((i) => i.key.startsWith('skill:') && pick(i)).map((i) => i.label);
    const requiredMissing = named((i) => i.state === 'missing' && i.disposition === 'apply');
    const optionalMissing = named((i) => i.state === 'missing' && i.disposition !== 'apply');
    const extra = named((i) => i.state === 'extra');
    const local = named((i) => i.state === 'local');
    const ok = named((i) => i.state === 'ok');
    // An unlistable store is a failed read, reported as such rather than as nothing installed.
    const storeErrors = skills.items.some((i) => i.state === 'unknown') ? skills.probeErrors : [];
    const skillLines: string[] = [];
    const countRow = (label: string, names: string[]) => {
      if (names.length) skillLines.push(formatRow(label, String(names.length), names.join(', ')));
    };
    countRow('missing', requiredMissing);
    countRow('optional', optionalMissing);
    countRow('extra', extra);
    countRow('local', local);
    // Nothing canonical means nothing to ask the agents about.
    const exposureRead = ok.length > 0 ? yield* readExposure(targets) : { list: {}, errors: [] };
    const exposure = skillExposure({ names: ok, targets, list: exposureRead.list });
    if (exposure.partial.length) {
      skillLines.push(formatRow('partial', String(exposure.partial.length), exposure.partial
        .map((p) => `${p.name} (missing from ${p.missing.map((t) => SKILL_AGENTS[t]).join(', ')})`).join(', ')));
    }
    // In the store and loadable by none of the selected agents: an install has nothing to add.
    countRow('unlinked', exposure.missing);
    for (const message of exposureRead.errors) skillLines.push(formatRow('exposure', 'unknown', message));
    for (const message of storeErrors) skillLines.push(formatRow('store', 'unknown', message));
    if (!skillLines.length) skillLines.push(formatRow('manifest', 'satisfied', ''));
    // Each gap names the command that can close it: install fills the store, update re-places a skill.
    const repairs: string[] = [];
    if (requiredMissing.length) repairs.push('  nortuscc apply --install');
    if (exposure.partial.length || exposure.missing.length) repairs.push('  nortuscc update');
    if (repairs.length) skillLines.push('', ...repairs);
    process.stdout.write(section('skills', skillLines));

    // undeclared: present on the machine, named by neither a declaration nor the allow list.
    const hookCommands = selected.integrations
      .map((i) => i.declaration)
      .filter((d) => d.type === 'hook' && typeof d.file === 'string' && d.file)
      .map((d) => hookCommand(paths.claude, d as Parameters<typeof hookCommand>[1]));
    const undeclared = yield* probeUndeclared(desired, { targets, installed, hookCommands });
    const probeErrors = [
      ...undeclared.probeErrors.map((e) => {
        const at = e.indexOf(': ');
        return { category: e.slice(0, at), message: e.slice(at + 2) };
      }),
      ...codexErrors.map((message) => ({ category: 'codex', message })),
    ];
    const undeclaredLines = [
      ...undeclared.items.map((i) => formatRow(i.group, i.label, i.note ?? '')),
      ...probeErrors.map((e) => formatRow(e.category, 'unknown', e.message)),
    ];
    if (undeclared.items.length) {
      undeclaredLines.push(
        '',
        `  ${undeclared.items.length} finding(s). Declare them in integrations.json, or list them`,
        '  under "allow" to accept them. --strict makes this exit non-zero.',
      );
    } else if (!probeErrors.length) {
      undeclaredLines.push(formatRow('all categories', 'declared', ''));
    }
    process.stdout.write(section('undeclared', undeclaredLines));

    const inventoryDirty = undeclared.items.length > 0 || probeErrors.length > 0;
    const strict = rest.includes('--strict');
    const actionable = rows.filter((r) => NEEDS_APPLY.has(r.state) || NEEDS_CAPTURE.has(r.state) || BLOCKED.has(r.state));
    // Reached only by declining the update or having no terminal. An unreachable remote is not counted:
    // being offline offers the user nothing to do.
    const cliBehind = cli.state === 'behind';
    // An undeclared item alone is informational; --strict is what makes it actionable.
    const otherDirty = cliBehind
      || actionable.length > 0
      || configErrors.length > 0
      || manifestErrors.length > 0
      || pending.length > 0
      || requiredMissing.length > 0
      || exposure.partial.length > 0
      || exposure.missing.length > 0
      || exposureRead.errors.length > 0
      || storeErrors.length > 0;

    if (!otherDirty && !inventoryDirty) {
      process.stdout.write('\neverything is in agreement\n');
      return 0;
    }
    // Skills and integrations printed their own advice; this speaks for the cli and config rows.
    const advice = [...(cliBehind ? ['  nortuscc pull     update nortuscc itself'] : []), suggestions(actionable)]
      .filter(Boolean).join('\n');
    if (advice) process.stdout.write('\n' + advice + '\n');
    if (otherDirty) return 1;
    return strict ? 1 : 0;
  });
}

const declarationOf = (desired: DesiredConfig, item: Observed) =>
  desired.integrations.find((i) => `integration:${i.id}` === item.key)?.declaration;
const isPlugin = (desired: DesiredConfig, item: Observed) => declarationOf(desired, item)?.type === 'plugin';
const pluginOf = (desired: DesiredConfig, item: Observed) => String(declarationOf(desired, item)?.plugin ?? '');

// `nortuscc status [--strict] [--versions]`. `deps` replaces the update check and its prompt in tests.
export async function run(args: string[] = [], deps: StatusDeps = {}): Promise<number> {
  // Config-mode flags first, then --target, so neither reaches a parser that would misread them.
  // Status never records a config-mode flag: it narrows this one report.
  const mode = parseConfigMode(args);
  const { target, rest, error } = parseTarget(mode.rest);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }
  return runCommand(() => Effect.gen(function* () {
    const opened = yield* openMachine({ mode });
    return yield* report(opened, { target, rest, mode, deps }).pipe(Effect.provide(opened.layer));
  }));
}
