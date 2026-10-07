import { join } from 'node:path';
import { Effect } from 'effect';
import { parseSkillsManifest, type Target } from '@nortuscc/profile-engine';
import {
  emitManifest, Fs, inspect, installedGroups, installedSkillNames, MachinePaths, MANIFEST_FILE, plan, readSkillLock,
  selectAll, type Domain, type Plan, type Step,
} from '@nortuscc/machine';
import { checkoutGroups, itemIdOf, type Holds } from '@nortuscc/sync';
import { parseConfigMode, resolveConfigMode, SKIPPED_LABEL, SKIPPED_NOTE, SKIPPED_STATE } from '../config-mode.ts';
import { CONFLICT_NOTE, fileOutcomes, HELD_REASON, UNPARSEABLE_NOTE } from '../config-rows.ts';
import { domainsFor, openCheckout, refuseInvalidOverrides, runCommand, runPlan, type CliServices, type Opened } from '../machine.ts';
import { formatRow, section } from '../report.ts';
import { parseTarget, selectedTargets } from '../targets.ts';

const CREDENTIAL_NOTE = 'looks like a credential — nothing captured';
// The prefix of a config step's note when the value it would have written looks like a credential.
const CREDENTIAL_REFUSAL = 'refused:';
const MANIFEST_LABEL = 'skills-manifest';
// A manifest step's note: `<state> — <detail>`, rendered as the `skills-manifest` row.
const NOTE_SEPARATOR = ' — ';

const MANIFEST_STEP: Step = {
  key: 'skills:manifest', domain: 'skills', action: 'write-manifest', summary: `write ${MANIFEST_FILE}`,
  touches: [MANIFEST_FILE], interruptible: false,
};

// Regenerates the repo's skills manifest from the skills installed here (in the lock and on disk),
// keeping the current manifest's markers and listing each `held` skill as the manifest declares it.
// Refuses to list fewer skills than the manifest does unless `allowShrink`; writes nothing when no
// skill is listed. The note is `<state> — <detail>`, or ''.
const writeManifest = (allowShrink: boolean, held: Holds) => Effect.gen(function* () {
  const fs = yield* Fs;
  const path = join((yield* MachinePaths).repo, MANIFEST_FILE);
  const before = parseSkillsManifest(yield* fs.readText(path));
  const groups = checkoutGroups(installedGroups(yield* readSkillLock, yield* installedSkillNames, before), before, held);
  const beforeCount = before.reduce((n, g) => n + g.skills.length, 0);
  const afterCount = groups.reduce((n, g) => n + g.skills.length, 0);
  if (afterCount < beforeCount && !allowShrink) {
    return { ok: true, note: `refused${NOTE_SEPARATOR}would drop ${beforeCount - afterCount} entr(ies); pass --allow-shrink` };
  }
  if (groups.length === 0) return { ok: true, note: '' };
  yield* fs.writeTextAtomic(path, emitManifest(groups));
  return { ok: true, note: `written${NOTE_SEPARATOR}${afterCount} skill(s)` };
});

// Runs only the manifest step, so it is written under the same apply lock as the configuration.
const manifestDomain = (allowShrink: boolean, held: Holds): Domain<Fs | MachinePaths> => ({
  name: 'skills',
  inspect: () => Effect.succeed({ items: [], probeErrors: [] }),
  steps: () => ({ steps: [], skipped: [] }),
  run: () => writeManifest(allowShrink, held),
});

// `planned` with every step for a held item moved to skipped, and every skipped held item re-labelled,
// as HELD_REASON: capture never writes a held item's machine value into the checkout.
const withoutHeld = (planned: Plan, isHeld: (key: string) => boolean): Plan => ({
  ...planned,
  steps: planned.steps.filter((step) => !isHeld(step.key)),
  skipped: [
    ...planned.skipped.map((s) => (isHeld(s.key) ? { key: s.key, reason: HELD_REASON } : s)),
    ...planned.steps.filter((step) => isHeld(step.key)).map((step) => ({ key: step.key, reason: HELD_REASON })),
  ],
});

// machine -> repo: captures the selected agents' local configuration edits into the repo, then
// regenerates the skills manifest. Held items (opened.held) are left as the checkout declares them.
// `captured` is the repo-relative paths written (each captured file's `src`, and `skills-manifest.txt`),
// for push to stage. `code` is 1 when a file was refused,
// could not be parsed or failed to write, or the run was cancelled, else 0.
export function capture(
  opened: Opened,
  input: { targets: Target[]; takeLocal: boolean; allowShrink: boolean; manageConfig: boolean; signal: AbortSignal },
): Effect.Effect<{ code: number; captured: string[] }, unknown, CliServices> {
  return Effect.gen(function* () {
    const { config } = domainsFor(opened.paths);
    const manifest = manifestDomain(input.allowShrink, opened.held);
    // On a skills-only machine no configuration file is read, written or captured.
    const report = yield* inspect(opened.desired, input.manageConfig ? [config] : []);
    if (report.probeErrors.length > 0) {
      for (const error of report.probeErrors) console.error(`nortuscc: ${error}`);
      console.error('nortuscc: configuration could not be read; nothing was captured.');
      return { code: 1, captured: [] };
    }
    const isHeld = (key: string) => {
      const id = itemIdOf(key, opened.desired);
      return id !== undefined && id in opened.held;
    };
    const planned = withoutHeld(plan('capture', report, { ...selectAll, targets: input.targets, force: input.takeLocal }, [config]), isHeld);
    const ran = yield* runPlan({ ...planned, steps: [...planned.steps, MANIFEST_STEP] }, report, [config, manifest], { signal: input.signal });

    const lines: string[] = [];
    const captured: string[] = [];
    let refused = 0;
    let unreadable = 0;
    let invalidValue = 0;
    let failed = 0;
    if (!input.manageConfig) lines.push(formatRow(SKIPPED_LABEL, SKIPPED_STATE, SKIPPED_NOTE));
    const files = input.manageConfig ? opened.desired.files.filter((f) => f.managed && input.targets.includes(f.target)) : [];
    for (const outcome of fileOutcomes(files, report, planned, ran)) {
      const { file, copied, backupNote, conflicts, held } = outcome;
      if (copied) captured.push(file.src);
      const credentials = outcome.failures.filter((f) => f.note.startsWith(CREDENTIAL_REFUSAL));
      const failure = outcome.failures.find((f) => !f.note.startsWith(CREDENTIAL_REFUSAL));
      // Settings keys capture one by one, so the keys not refused may already have been written.
      const partly = (what: string, keys: string[]) =>
        `${what} on ${keys.join(', ')}; other keys copied${backupNote ? `; ${backupNote}` : ''}`;
      if (!file.capture) {
        lines.push(formatRow(file.dest, 'repo-owned', 'local changes are never captured'));
      } else if (failure) {
        failed += 1;
        lines.push(formatRow(file.dest, failure.outcome, failure.note));
      } else if (credentials.length > 0) {
        // No flag can force a credential into a committed file; the fix is the local value.
        invalidValue += 1;
        lines.push(formatRow(file.dest, 'refused', copied ? partly('credential refused', credentials.map((f) => f.key)) : CREDENTIAL_NOTE));
      } else if (outcome.unparseable) {
        // --take-local is a conflict remedy; it cannot fix invalid JSON.
        unreadable += 1;
        lines.push(formatRow(file.dest, 'refused', UNPARSEABLE_NOTE));
      } else if (conflicts.length > 0) {
        refused += 1;
        lines.push(formatRow(file.dest, 'refused', copied ? partly('conflict', conflicts) : CONFLICT_NOTE));
      } else if (copied) {
        const heldNote = held.length > 0 ? `held: ${held.join(', ')}` : '';
        lines.push(formatRow(file.dest, 'copied', [backupNote, heldNote].filter(Boolean).join('; ')));
      } else if (held.length > 0) {
        lines.push(formatRow(file.dest, 'held', 'not captured while held'));
      } else {
        lines.push(formatRow(file.dest, 'skipped'));
      }
    }

    const written = ran.results.find((r) => r.step === MANIFEST_STEP);
    if (written?.outcome === 'ok' && written.note) {
      const [state = '', detail = ''] = written.note.split(NOTE_SEPARATOR);
      if (state === 'written') captured.push(MANIFEST_FILE);
      lines.push(formatRow(MANIFEST_LABEL, state, detail));
    } else if (written) {
      failed += 1;
      lines.push(formatRow(MANIFEST_LABEL, written.outcome, written.note));
    }
    process.stdout.write('\n' + section('capture', lines));

    if (unreadable > 0) {
      process.stdout.write(
        `\n${unreadable} settings file(s) could not be parsed and were left untouched.\n` +
          '  fix the JSON by hand, then re-run capture\n',
      );
    }
    if (invalidValue > 0) {
      process.stdout.write(
        `\n${invalidValue} key(s) held a value that looks like a credential and were left uncaptured.\n` +
          '  this file is committed; fix the local value, then re-run capture\n',
      );
    }
    if (refused > 0) process.stdout.write(`\n${refused} conflict(s) refused. Use --take-local to keep the local version.\n`);
    if (failed > 0) process.stdout.write(`\n${failed} file(s) could not be written. See the rows above.\n`);
    if (ran.cancelled) process.stdout.write('\ncancelled; the remaining files were not captured\n');
    const code = refused + unreadable + invalidValue + failed > 0 || ran.cancelled ? 1 : 0;
    return { code, captured };
  });
}

// `nortuscc capture`: machine -> repo. Honours the config mode for this run; never records it.
export async function run(args: string[] = []): Promise<number> {
  const mode = parseConfigMode(args);
  const { target, rest, error } = parseTarget(mode.rest);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }
  const takeLocal = rest.includes('--take-local');
  const takeRepo = rest.includes('--take-repo');
  if (takeRepo && takeLocal) {
    console.error('nortuscc: --take-repo and --take-local are mutually exclusive');
    return 2;
  }
  // capture only moves machine -> repo; discarding the local version is apply's job.
  if (takeRepo) {
    console.error(
      "nortuscc: --take-repo has no effect on capture (capture is machine -> repo).\n" +
        "Use 'nortuscc apply --take-repo' to discard the local version instead.",
    );
    return 2;
  }
  const targets = selectedTargets(target);

  return runCommand((signal) => Effect.gen(function* () {
    // Holds are read, not composed: capture writes into the checkout itself.
    const opened = yield* openCheckout({ mode });
    if (refuseInvalidOverrides(opened.overrides)) return 1;
    const { manageConfig } = resolveConfigMode(mode, opened.overrides.value);
    const result = yield* capture(opened, { targets, takeLocal, allowShrink: rest.includes('--allow-shrink'), manageConfig, signal })
      .pipe(Effect.provide(opened.layer));
    return result.code;
  }));
}
