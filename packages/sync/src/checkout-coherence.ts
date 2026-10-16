import { join } from 'node:path';
import { Data, Effect } from 'effect';
import { Fs, Processes, type FsFailed, type LaunchFailed, type MachinePathsValue } from '@nortuscc/machine';

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type CheckoutRelation = 'compatible' | 'behind' | 'diverged' | 'unavailable';

export class CheckoutCoherenceFailed extends Data.TaggedError('CheckoutCoherenceFailed')<{
  readonly relation: Exclude<CheckoutRelation, 'compatible'>;
}> {
  override get message() {
    return `CLI checkout refused (${this.relation}): HEAD must contain the machine's applied setup commit. Update the author checkout before changing this machine.`;
  }
}

// Ancestry only. Never changes HEAD, the index or author working-tree edits.
export const checkoutCoherence = (input: { repo: string; applied: string | undefined }):
  Effect.Effect<CheckoutRelation, LaunchFailed, Processes> => Effect.gen(function* () {
    if (input.applied === undefined) return 'compatible';
    if (!COMMIT.test(input.applied)) return 'unavailable';
    const processes = yield* Processes;
    const git = (args: readonly string[]) => processes.run({ cmd: 'git', args: [
      '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args,
    ], cwd: input.repo, output: 'capture', stderr: 'capture', env: {
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    } });
    const head = yield* git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const applied = yield* git(['rev-parse', '--verify', '--quiet', `${input.applied}^{commit}`]);
    if (head.code !== 0 || !COMMIT.test(head.stdout.trim()) || applied.code !== 0 || applied.stdout.trim() !== input.applied) return 'unavailable';
    const contains = yield* git(['merge-base', '--is-ancestor', input.applied, head.stdout.trim()]);
    if (contains.code === 0) return 'compatible';
    if (contains.code !== 1) return 'unavailable';
    const behind = yield* git(['merge-base', '--is-ancestor', head.stdout.trim(), input.applied]);
    return behind.code === 0 ? 'behind' : behind.code === 1 ? 'diverged' : 'unavailable';
  });

// Read only the applied commit before a store read can migrate legacy choices.
export const requireCheckoutCoherence = (paths: MachinePathsValue):
  Effect.Effect<void, CheckoutCoherenceFailed | LaunchFailed | FsFailed, Fs | Processes> => Effect.gen(function* () {
    const text = yield* (yield* Fs).readText(join(paths.stateRoot, 'state.json'));
    const applied = yield* Effect.try({ try: () => {
      if (text === undefined) return undefined;
      const state: unknown = JSON.parse(text);
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid state');
      if (!('applied' in state)) return undefined;
      const value = state.applied;
      if (!value || typeof value !== 'object' || !('commit' in value) || typeof value.commit !== 'string'
        || !('at' in value) || typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) throw new Error('invalid baseline');
      return value.commit;
    }, catch: () => new CheckoutCoherenceFailed({ relation: 'unavailable' }) });
    const relation = yield* checkoutCoherence({ repo: paths.repo, applied });
    if (relation !== 'compatible') return yield* Effect.fail(new CheckoutCoherenceFailed({ relation }));
  });
