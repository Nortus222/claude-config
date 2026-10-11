import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { loadProfile, nodeFiles, requireValid } from '@nortuscc/profile-engine';
import {
  acquirePidLock, Backups, backupsForRun, Fs, isGitCheckout, machinePaths, nodeFs, nodeProcesses,
  OverridesStore, overridesStore, parseState, pathsFromEnvironment, Processes, StateStore, stateStore,
} from '@nortuscc/machine';

import { decodeSetupChoices, DEFAULT_REPO_URL, type SetupChoices, type SetupState } from '../shared/setup-protocol.ts';
export { decodeSetupChoices, decodeSetupState, DEFAULT_REPO_URL, SetupChoicesSchema, SetupStateSchema, type SetupChoices, type SetupState } from '../shared/setup-protocol.ts';

export type OnboardingInput = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly processes?: Layer.Layer<Processes>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};
const pathsFor = (input: OnboardingInput) => pathsFromEnvironment({ ...input, fallbackRepo: input.home });
// Never run Apple's /usr/bin/git shim during a read-only prerequisite check.
const findGit = (input: OnboardingInput) => Effect.gen(function* () {
  const processes = yield* Processes;
  if (input.platform !== 'darwin') {
    const result = yield* processes.run({ cmd: 'git', args: ['--version'], output: 'capture', stderr: 'capture' });
    return result.code === 0 ? 'git' : null;
  }
  const fs = yield* Fs;
  for (const folder of (input.env.PATH ?? '').split(':').filter((path) => isAbsolute(path))) {
    const candidate = yield* fs.realPath(join(folder, 'git'));
    if (candidate === undefined || candidate === '/usr/bin/git' || (yield* fs.stat(candidate))?.kind !== 'file') continue;
    const result = yield* processes.run({ cmd: candidate, args: ['--version'], output: 'capture', stderr: 'capture' });
    if (result.code === 0) return candidate;
  }
  const result = yield* processes.run({ cmd: '/usr/bin/xcode-select', args: ['-p'], output: 'capture', stderr: 'capture' });
  const developer = result.stdout.trim();
  if (result.code !== 0 || !isAbsolute(developer) || /[\x00-\x1f\x7f]/.test(developer)) return null;
  const candidate = join(developer, 'usr/bin/git');
  return (yield* fs.stat(candidate))?.kind === 'file' ? candidate : null;
}).pipe(Effect.timeout(input.timeoutMs ?? 10_000), Effect.catch(() => Effect.succeed(null)),
  Effect.provide(Layer.mergeAll(nodeFs, input.processes ?? nodeProcesses({ env: input.env, inherit: 'stderr' }))));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The legacy store normalizes missing fields; onboarding must refuse corrupt setup authority first.
const validSetupRecord = (text: string): boolean => {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return false; }
  if (!isRecord(value) || !Object.hasOwn(value, 'repo') || !(value.repo === null || typeof value.repo === 'string')
    || (Object.hasOwn(value, 'version') && value.version !== 1) || !isRecord(value.files)) return false;
  if (!Object.values(value.files).every((baseline) => isRecord(baseline)
    && typeof baseline.hash === 'string' && typeof baseline.appliedAt === 'string')) return false;
  if (Object.hasOwn(value, 'skillsOnly') && typeof value.skillsOnly !== 'boolean') return false;
  if (Object.hasOwn(value, 'configTargets') && (!Array.isArray(value.configTargets)
    || !value.configTargets.every((target) => target === 'claude' || target === 'codex'))) return false;
  return true;
};
export const setupState = async (input: OnboardingInput): Promise<SetupState> => {
  const paths = await Effect.runPromise(pathsFor(input));
  const recorded = await Effect.runPromise(Effect.gen(function* () {
    const fs = yield* Fs;
    let repo: string | null = null;
    for (const path of [join(paths.stateRoot, 'state.json'), join(paths.claude, '.nortuscc-lock.json')]) {
      const text = yield* fs.readText(path);
      if (text === undefined) continue;
      const state = validSetupRecord(text) ? parseState(text) : undefined;
      if (state === undefined) throw new Error(`${path} is invalid; repair it before setting up`);
      repo = state.repo;
      break;
    }
    return input.env.NORTUSCC_REPO_DIR || repo;
  }).pipe(Effect.provide(nodeFs)));
  if (recorded !== null && (!isAbsolute(recorded) || !isGitCheckout(recorded))) throw new Error('the recorded repository is not an existing checkout; repair its record');
  return { needsSetup: recorded === null, repo: recorded, gitAvailable: (await Effect.runPromise(findGit(input))) !== null,
    canInstallGit: input.platform === 'darwin', defaultRepoUrl: DEFAULT_REPO_URL };
};

export const requestGitInstall = async (input: OnboardingInput): Promise<void> => {
  if (input.platform !== 'darwin') throw new Error('the system Git installer is available only on macOS');
  await Effect.runPromise(Processes.use((processes) => processes.run({ cmd: '/usr/bin/xcode-select', args: ['--install'],
    output: 'capture', stderr: 'capture' })).pipe(Effect.flatMap((result) => result.code === 0 ? Effect.void
      : Effect.fail(new Error('Apple Command Line Tools installer could not be opened; finish any existing installer and retry'))),
    Effect.timeout(input.timeoutMs ?? 10_000), Effect.provide(input.processes ?? nodeProcesses({ env: input.env, inherit: 'stderr' }))), { signal: input.signal });
};

// Clone and record only; the native owner runs normal ensure afterward, without applying configuration.
export const bootstrapSetup = async (input: OnboardingInput, rawChoices: SetupChoices): Promise<{ stateRoot: string }> => {
  const choices = decodeSetupChoices(rawChoices);
  const paths = await Effect.runPromise(pathsFor(input));
  const isolatedEnv = { ...Object.fromEntries(Object.entries(input.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false', GCM_INTERACTIVE: 'never' };
  const services = Layer.mergeAll(stateStore, overridesStore).pipe(Layer.provideMerge(Layer.mergeAll(
    machinePaths(paths), nodeFs, input.processes ?? nodeProcesses({ env: isolatedEnv, inherit: 'stderr' }))));
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* acquirePidLock(join(paths.stateRoot, 'apply.lock'));
    const current = yield* Effect.tryPromise({ try: () => setupState(input), catch: (error) => error });
    if (!current.needsSetup) return { stateRoot: paths.stateRoot };
    if (!current.gitAvailable) return yield* Effect.fail(new Error('Git is required; install it and recheck before setup'));
    const fs = yield* Fs;
    const overrides = yield* (yield* OverridesStore).read;
    if (overrides.issues.length) return yield* Effect.fail(new Error('overrides.json is invalid; repair it before setting up'));
    // Exclusively reserve a native-owned parent. Promotion inside it cannot replace somebody else's checkout.
    const root = join(paths.stateRoot, `desktop-setup-${randomUUID()}`);
    const temp = join(root, '.clone');
    const repo = join(root, 'repo');
    yield* Effect.tryPromise({ try: () => mkdir(root), catch: (error) => error });
    let promoted = false;
    yield* Effect.addFinalizer(() => promoted ? Effect.void : fs.remove(root).pipe(Effect.orDie));
    const processes = yield* Processes;
    const gitCommand = yield* findGit(input);
    if (gitCommand === null) return yield* Effect.fail(new Error('Git is required; install it and retry'));
    const git = (args: readonly string[]) => processes.run({ cmd: gitCommand, args: ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args],
      env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false', GCM_INTERACTIVE: 'never' },
      output: 'capture', stderr: 'capture' }).pipe(Effect.flatMap((result) => result.code === 0 ? Effect.succeed(result.stdout)
        : Effect.fail(new Error('setup Git operation failed; check network access and retry'))));
    yield* git(['clone', '--', DEFAULT_REPO_URL, temp]).pipe(Effect.timeout(input.timeoutMs ?? 120_000));
    if (!isGitCheckout(temp)) return yield* Effect.fail(new Error('cloned repository is not a checkout'));
    const origin = yield* git(['-C', temp, 'remote', 'get-url', 'origin']);
    if (origin.trim() !== DEFAULT_REPO_URL) return yield* Effect.fail(new Error('cloned repository has an unexpected origin'));
    yield* git(['-C', temp, 'rev-parse', '--verify', 'HEAD']);
    if (!(yield* fs.exists(join(temp, 'integrations.json'))) || !(yield* fs.exists(join(temp, 'skills-manifest.txt')))) {
      return yield* Effect.fail(new Error('cloned repository is missing profile documents'));
    }
    yield* loadProfile(temp).pipe(Effect.flatMap(requireValid), Effect.provide(nodeFiles));
    yield* fs.move(temp, repo);
    promoted = true;
    const backups = yield* Backups;
    for (const name of ['state.json', 'overrides.json']) yield* backups.preserve(join(paths.stateRoot, name), name);
    yield* backups.preserve(join(paths.stateRoot, 'agent', 'agent.json'), 'agent.json', 'agent');
    // Explicit current or legacy target choices win; unrelated overrides do not answer the picker.
    if (overrides.value.manageConfig === undefined && overrides.value.configTargets === undefined) {
      yield* (yield* OverridesStore).write({ ...overrides.value,
        manageConfig: choices.configTargets.length > 0, configTargets: choices.configTargets });
    }
    if (!(yield* fs.exists(join(paths.stateRoot, 'agent', 'agent.json')))) yield* fs.writeTextAtomic(
      join(paths.stateRoot, 'agent', 'agent.json'), JSON.stringify({ version: 1, policy: 'notify', policySource: 'default', paused: null }) + '\n');
    // Publish the repo record last: a retry never mistakes incomplete metadata for a completed setup.
    yield* (yield* StateStore).update((before) => ({ ...before, repo }));
    return { stateRoot: paths.stateRoot };
  })).pipe(Effect.provide(backupsForRun().pipe(Layer.provideMerge(services)))), { signal: input.signal });
};
