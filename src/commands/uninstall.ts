import { Cause, Effect, Stream } from 'effect';
import {
  CHANGED_SINCE_APPLY, configDomain, configFileId, execute, inspect, OverridesStore, plan, selectAll, splitOutcome,
} from '@nortuscc/machine';
import { openDesired } from '../machine.ts';
import { formatRow, section } from '../report.ts';
import { parseTarget } from '../targets.ts';

// Restores or removes every file nortuscc recorded, then records this machine as skills-only.
const uninstall = (force: boolean, signal: AbortSignal) =>
  Effect.scoped(Effect.gen(function* () {
    const opened = yield* openDesired();
    const { desired } = opened;
    return yield* Effect.gen(function* () {
      const overridesFile = yield* OverridesStore;
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

      const overrides = yield* overridesFile.read;
      if (overrides.issues.length > 0) {
        console.error(`nortuscc: ${overrides.source} is not valid, so nothing was uninstalled; fix it or set "manageConfig": false there by hand.`);
        return 1;
      }
      // Record skills-only before restoring: a concurrent run that starts after this point no longer applies
      // configuration, and an interrupted uninstall is completed by re-running it (uninstall restores every
      // recorded file whether or not the machine manages configuration). overrides.json is the only record.
      yield* overridesFile.write({ ...overrides.value, manageConfig: false });

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
        const { action, backedUp, older } = splitOutcome(event.note);
        // An older backup may be the original or an old capture's repo copy (#72); the user decides.
        const notes = [backedUp && `backed up -> ${backedUp}`, older && `not restored, from before the cutoff -> ${older}`];
        lines.push(formatRow(label(event.key), action, notes.filter(Boolean).join('; ')));
      }));
      process.stdout.write('\n' + section('uninstall', lines));

      if (!run.complete) {
        console.error("nortuscc: uninstall did not finish; re-run 'nortuscc uninstall --yes' to complete it.");
        return 1;
      }
      return 0;
    }).pipe(Effect.provide(opened.layer));
  }));

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
