import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Cause, Effect, Layer, Stream } from 'effect';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import {
  backupsForRun, CHANGED_SINCE_APPLY, configDomain, configFileId, execute, inspect, machinePaths, nodeFs,
  OverridesStore, overridesStore, pathsFromEnvironment, plan, selectAll, splitOutcome, StateStore, stateStore,
} from '@nortuscc/machine';
import { formatRow, section } from '../report.ts';
import { parseTarget } from '../targets.ts';

const CHECKOUT = fileURLToPath(new URL('../..', import.meta.url));

// Restores or removes every file nortuscc recorded, then records this machine as skills-only.
const uninstall = (force: boolean, signal: AbortSignal) =>
  Effect.gen(function* () {
    const paths = yield* pathsFromEnvironment({
      env: process.env, home: homedir(), platform: process.platform, fallbackRepo: CHECKOUT, warn: (m) => console.error(m),
    });
    const services = Layer.mergeAll(stateStore, overridesStore, backupsForRun())
      .pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs)));

    return yield* Effect.gen(function* () {
      const overridesFile = yield* OverridesStore;
      const desired = yield* loadProfile(paths.repo, { overrides: yield* overridesFile.read }).pipe(Effect.provide(nodeFiles));
      const report = yield* inspect(desired, [configDomain]);
      if (report.probeErrors.length > 0) {
        for (const error of report.probeErrors) console.error(`nortuscc: ${error}`);
        console.error('nortuscc: nothing was uninstalled.');
        return 1;
      }

      const label = (key: string) => desired.files.find((f) => f.id === configFileId(key))?.dest ?? key;
      const planned = plan('uninstall', report, { ...selectAll, force }, [configDomain]);
      const changed = planned.skipped.filter((s) => s.reason === CHANGED_SINCE_APPLY);
      if (changed.length > 0) {
        process.stdout.write(
          '\n' + section('uninstall', changed.map((s) => formatRow(label(s.key), 'changed', 'left untouched')))
            + `\n${changed.length} managed file(s) changed; nothing was uninstalled. Re-run with --force to preserve and replace them.\n`,
        );
        return 1;
      }

      const lines: string[] = [];
      const run = { complete: true };
      yield* Stream.runForEach(execute(planned, report, [configDomain], { signal }), (event) => Effect.sync(() => {
        if (event.type === 'cancelled') run.complete = false;
        if (event.type !== 'finished') return;
        if (event.outcome !== 'ok') {
          run.complete = false;
          lines.push(formatRow(label(event.key), event.outcome, event.note));
          return;
        }
        const { action, backedUp } = splitOutcome(event.note);
        lines.push(formatRow(label(event.key), action, backedUp ? `backed up -> ${backedUp}` : ''));
      }));
      process.stdout.write('\n' + section('uninstall', lines));
      if (!run.complete) return 1;

      // overrides.json holds the choice; state.json keeps the legacy copy until cutover (#59).
      const overrides = yield* overridesFile.read;
      yield* (yield* StateStore).update((state) => ({ ...state, skillsOnly: true }));
      if (overrides.issues.length > 0) {
        console.error(`nortuscc: ${overrides.source} is not valid, so it was left as it is; set "manageConfig": false there by hand.`);
        return 1;
      }
      yield* overridesFile.write({ ...overrides.value, manageConfig: false });
      return 0;
    }).pipe(Effect.provide(services));
  });

export async function run(args: string[] = []): Promise<number> {
  const { target, rest, error } = parseTarget(args);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }
  if (target !== 'all') {
    console.error('nortuscc: uninstall applies to the whole machine; --target must be all');
    return 2;
  }
  const unknown = rest.filter((arg: string) => arg !== '--yes' && arg !== '--force');
  if (unknown.length > 0) {
    console.error(`nortuscc: unknown uninstall option '${unknown[0]}'`);
    return 2;
  }
  if (!rest.includes('--yes')) {
    console.error('nortuscc: uninstall changes files. Re-run with --yes to confirm.');
    return 2;
  }

  // SIGINT finishes the current file, then stops: bookkeeping always matches the files.
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    return await Effect.runPromise(uninstall(rest.includes('--force'), controller.signal).pipe(
      Effect.catchCause((cause) => Effect.sync(() => {
        const failure = Cause.squash(cause);
        console.error(`nortuscc: ${failure instanceof Error ? failure.message : String(failure)}`);
        return 1;
      })),
    ));
  } finally {
    process.off('SIGINT', cancel);
  }
}
