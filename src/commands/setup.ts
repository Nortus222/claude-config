import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Effect } from 'effect';
import type { MachineOverrides, Target } from '@nortuscc/profile-engine';
import { isGitCheckout, OverridesStore, StateStore } from '@nortuscc/machine';
import { parseConfigMode, persisted, resolveConfigMode } from '../config-mode.ts';
import { runGit } from '../git.ts';
import { parseInstallFlags, runInstall } from '../install.ts';
import { cliLayer, openMachine, resolvePaths, runCommand } from '../machine.ts';
import { setupPrerequisites, type PrerequisiteDeps } from '../prerequisites.ts';
import { confirm as realConfirm } from '../prompt.ts';
import { select as realSelect, type Choice } from '../select.ts';
import { parseTarget, selectedTargets } from '../targets.ts';
import { applyConfig } from './apply.ts';
import { run as statusRun, type StatusDeps } from './status.ts';

// `nortuscc setup` in a checkout: choose what this machine manages, offer prerequisites, record the
// repo and the choice, apply configuration, install integrations and skills, then report status.
// An npx copy never gets here: bin/launcher.mjs clones the checkout and hands the run to it.

const DEFAULT_REPO = 'https://github.com/Nortus222/claude-config.git';

const T3_HANDOFF =
  '\nT3 Code provider handoff:\n' +
  '  Display name: Codex · GLM Flash\n' +
  '  CODEX_HOME path: ~/.codex-openrouter\n' +
  '  Environment: OPENROUTER_API_KEY (enter it as a sensitive value)\n' +
  '  Restart T3 Code, refresh providers, then select z-ai/glm-5.3-flash.\n';

// Stand-ins for the terminal, so a test can drive the interactive flow.
export type SetupDeps = {
  isTTY?: boolean;
  // The agent-configuration picker.
  selectConfig?: typeof realSelect;
  // The install picker and its confirmation; `confirm` also answers prerequisites unless they bring their own.
  select?: typeof realSelect;
  confirm?: typeof realConfirm;
  prerequisites?: PrerequisiteDeps;
  status?: StatusDeps;
};

function flag(args: readonly string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
}

// Clones `url` into `dir` with git's own output; returns why it failed, or null.
function cloneRepo(url: string, dir: string): string | null {
  const cloned = spawnSync('git', ['clone', url, dir], { stdio: 'inherit' });
  if (cloned.error) return cloned.error.message;
  return cloned.status === 0 ? null : `git exited with ${cloned.status ?? cloned.signal}`;
}

export async function run(args: string[] = [], deps: SetupDeps = {}): Promise<number> {
  // setup is where a machine says what it wants managed, so it records the choice rather than
  // merely honouring it.
  const mode = parseConfigMode(args);
  const { target, rest, error } = parseTarget(mode.rest);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const flags = parseInstallFlags(rest.filter((arg) => arg === '--yes' || arg.startsWith('--no-')));
  if (flags.error || rest.includes('--take-local')) {
    console.error(`nortuscc: ${flags.error ?? 'Use capture --take-local to keep local configuration.'}`);
    return 2;
  }
  if (!isTTY && !flags.yes) {
    console.error('nortuscc: no terminal to choose on. Re-run with --yes to accept the defaults.');
    return 2;
  }
  const targets = selectedTargets(target);
  const requestedDir = flag(rest, '--dir');
  const dir = requestedDir === null ? null : resolve(requestedDir);
  const url = flag(rest, '--repo') ?? DEFAULT_REPO;

  let finished = false;
  const code = await runCommand((signal) => Effect.gen(function* () {
    // setup repairs a stale record itself, so the "re-run setup" warning would prescribe this very run.
    const paths = yield* resolvePaths();
    const layer = cliLayer(paths);
    const overrides = yield* Effect.provide(Effect.gen(function* () { return yield* (yield* OverridesStore).read; }), layer);

    // The picker only asks when no flag already said what to manage.
    let picked: { manageConfig: boolean; configTargets: Target[] } | null = null;
    if (isTTY && !flags.yes && mode.persist === null && !mode.once) {
      const recorded = resolveConfigMode(mode, overrides.value);
      const choices: Choice[] = targets.map((agent) => ({
        key: agent,
        group: 'agent configuration',
        label: agent === 'claude' ? 'Claude: CLAUDE.md and settings' : 'Codex: AGENTS.md and provider files',
        note: '',
        checked: recorded.manageConfig && recorded.configTargets.includes(agent),
      }));
      console.log('Skills are offered next. Select neither configuration for skills alone, one agent, or both.');
      const keys = yield* Effect.promise(() =>
        (deps.selectConfig ?? realSelect)(choices, { title: 'choose which agent configuration to manage', isTTY }));
      if (keys === null) {
        console.log('cancelled; no configuration was changed');
        return 0;
      }
      const configTargets = targets.filter((agent) => keys.includes(agent));
      picked = { manageConfig: configTargets.length > 0, configTargets };
    }

    if (isTTY && !flags.yes) {
      const prerequisites = yield* Effect.promise(() =>
        setupPrerequisites({ ...deps.prerequisites, isTTY, confirm: deps.prerequisites?.confirm ?? deps.confirm ?? realConfirm }));
      if (prerequisites !== 0) return prerequisites;
    }

    if (dir && !existsSync(dir)) {
      console.log(`cloning ${url} -> ${dir}`);
      const failure = cloneRepo(url, dir);
      if (failure) {
        console.error(`failed to clone ${url}: ${failure}`);
        return 1;
      }
    }
    // An interrupted clone leaves the directory behind. Recording it would point every later
    // command at a path that is not a checkout, so refuse instead.
    if (dir && !isGitCheckout(dir)) {
      console.error(
        `nortuscc: ${dir} exists but is not a git checkout.\n` +
          'Remove it and re-run setup to clone into it, or pass a --dir that names a clone.',
      );
      return 2;
    }

    const root = dir ?? paths.repo;
    console.log(`repo: ${root}`);
    const commit = runGit(root, ['rev-parse', '--short', 'HEAD'], 'capture');
    console.log(commit.code === 0 ? `commit: ${commit.stdout.trim()}` : 'commit: unknown (not a git checkout)');

    // Where the repo lives and what this machine manages are recorded before apply runs, so the
    // first apply already honours the choice.
    const next: MachineOverrides | undefined = picked
      ? { ...overrides.value, manageConfig: picked.manageConfig, configTargets: picked.configTargets }
      : persisted(mode, overrides.value);
    if (next !== undefined && overrides.issues.length > 0) {
      console.error(`nortuscc: ${overrides.source} is not valid, so the choice was not recorded; fix it by hand.`);
      return 1;
    }
    yield* Effect.provide(Effect.gen(function* () {
      yield* (yield* StateStore).update((state) => ({ ...state, repo: root }));
      if (next !== undefined) yield* (yield* OverridesStore).write(next);
    }), layer);

    const opened = yield* openMachine({ mode, paths: { ...paths, repo: root } });
    return yield* Effect.gen(function* () {
      const { manageConfig, configTargets } = resolveConfigMode(mode, opened.overrides.value);
      if (!manageConfig) console.log('skills-only: this machine keeps its own agent configuration');

      // Configuration first, so a conflict is decided before any installer runs.
      const applied = yield* applyConfig(opened, { targets, takeRepo: rest.includes('--take-repo'), manageConfig, signal });
      if (applied !== 0) return applied;

      if (manageConfig && configTargets.includes('codex') && target !== 'claude') process.stdout.write(T3_HANDOFF);

      // Choosing skills alone in the picker declines the integrations too.
      const declined = picked && !picked.manageConfig
        ? [...new Set([...flags.declined, 'hooks', 'mcp', 'plugins'] as const)]
        : flags.declined;
      const installed = yield* runInstall(opened, {
        targets,
        flags: { ...flags, declined },
        isTTY,
        signal,
        ...(deps.select ? { select: deps.select } : {}),
        ...(deps.confirm ? { confirm: deps.confirm } : {}),
      });
      if (installed !== 0) return installed;
      finished = true;
      return 0;
    }).pipe(Effect.provide(opened.layer));
  }));
  if (!finished) return code;

  console.log('\n--- status ---');
  return statusRun(['--target', target, ...(mode.once ? ['--with-config'] : [])], deps.status);
}
