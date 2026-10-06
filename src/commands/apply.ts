import { join } from 'node:path';
import { Effect } from 'effect';
import type { Target } from '@nortuscc/profile-engine';
import {
  configFileId, inspect, OverridesStore, plan, selectAll, splitOutcome, StateStore, type Skipped,
} from '@nortuscc/machine';
import { parseConfigMode, persisted, resolveConfigMode, SKIPPED_LABEL, SKIPPED_NOTE, SKIPPED_STATE } from '../config-mode.ts';
import { parseInstallFlags, runInstall } from '../install.ts';
import { domainsFor, openMachine, runCommand, runPlan, type CliServices, type Opened } from '../machine.ts';
import { formatRow, section } from '../report.ts';
import { parseTarget, selectedTargets } from '../targets.ts';

const CONFLICT_NOTE = 'conflict — nothing changed';
const UNPARSEABLE_NOTE = 'could not be parsed as JSON — fix it by hand, then re-run';

// repo -> machine for the selected agents' configuration: one row per managed file, then the
// restart reminder when something was written and the trailers for what was refused. Returns 1
// when a file was refused, could not be parsed or failed to write, else 0.
export function applyConfig(opened: Opened, input: { targets: Target[]; takeRepo: boolean; manageConfig: boolean; signal: AbortSignal }):
  Effect.Effect<number, unknown, CliServices> {
  return Effect.gen(function* () {
    // On a skills-only machine no configuration file is read, written or backed up.
    if (!input.manageConfig) {
      process.stdout.write('\n' + section('apply', [formatRow(SKIPPED_LABEL, SKIPPED_STATE, SKIPPED_NOTE)]));
      return 0;
    }

    const { config } = domainsFor(opened.paths);
    const report = yield* inspect(opened.desired, [config]);
    if (report.probeErrors.length > 0) {
      for (const error of report.probeErrors) console.error(`nortuscc: ${error}`);
      console.error('nortuscc: configuration could not be read; nothing was applied.');
      return 1;
    }
    const planned = plan('apply', report, { ...selectAll, targets: input.targets, force: input.takeRepo }, [config]);
    // A clean machine runs nothing, so state.json and the backups folder stay untouched.
    const ran = planned.steps.length > 0 ? yield* runPlan(planned, report, [config], { signal: input.signal }) : undefined;

    const lines: string[] = [];
    let refused = 0;
    let unreadable = 0;
    let failed = 0;
    let changed = false;
    const files = opened.desired.files.filter((f) => f.managed && input.targets.includes(f.target));
    for (const file of files) {
      const mine = <T extends { key: string }>(entries: ReadonlyArray<T>) => entries.filter((e) => configFileId(e.key) === file.id);
      const stateOf = (s: Skipped) => report.items.find((i) => i.key === s.key)?.state;
      const results = mine((ran?.results ?? []).map((r) => ({ ...r, key: r.step.key })));
      const skipped = mine(planned.skipped);
      const copied = results.filter((r) => r.outcome === 'ok' && splitOutcome(r.note).action === 'copied');
      if (copied.length > 0) changed = true;

      const failure = results.find((r) => r.outcome !== 'ok');
      if (failure) {
        failed += 1;
        lines.push(formatRow(file.dest, failure.outcome, failure.note));
      } else if (skipped.some((s) => stateOf(s) === 'unparseable-local')) {
        // Neither --take-repo nor --take-local can fix invalid JSON, so it is counted apart.
        unreadable += 1;
        lines.push(formatRow(file.dest, 'refused', UNPARSEABLE_NOTE));
      } else if (skipped.some((s) => stateOf(s) === 'conflict')) {
        refused += 1;
        lines.push(formatRow(file.dest, 'refused', CONFLICT_NOTE));
      } else if (copied.length > 0) {
        const backedUp = copied.map((r) => splitOutcome(r.note).backedUp).find(Boolean);
        lines.push(formatRow(file.dest, 'copied', backedUp ? `backed up -> ${backedUp}` : ''));
      } else {
        // In sync, changed only here, or blocked in the repo: nothing written. A blocked file says why.
        const blocked = skipped.find((s) => ['missing-repo', 'invalid'].includes(stateOf(s) ?? ''));
        lines.push(formatRow(file.dest, 'skipped', blocked?.reason ?? ''));
      }
    }
    process.stdout.write('\n' + section('apply', lines));

    // Agents read their configuration at startup, so a write has no effect until a restart.
    if (changed) process.stdout.write('\nRestart the affected agent or T3 Code to load the synced configuration.\n');
    if (unreadable > 0) {
      process.stdout.write(
        `\n${unreadable} settings file(s) could not be parsed and were left untouched.\n` +
          '  fix the JSON by hand, then re-run apply\n',
      );
    }
    if (refused > 0) {
      process.stdout.write(
        `\n${refused} conflict(s) refused. Resolve with:\n` +
          '  nortuscc apply --take-repo    discard the local version\n' +
          '  nortuscc capture --take-local keep the local version\n',
      );
    }
    if (failed > 0) process.stdout.write(`\n${failed} file(s) could not be written. See the rows above.\n`);
    if (ran?.cancelled) process.stdout.write('\ncancelled; the remaining files were not applied\n');
    return refused + unreadable + failed > 0 || ran?.cancelled ? 1 : 0;
  });
}

const DEPRECATED_SKILLS = "\nnortuscc: --skills is deprecated; use 'nortuscc apply --install --no-hooks --no-mcp --no-plugins'\n";

// `nortuscc apply`: repo -> machine for configuration, then, with --install, the install workflow.
export async function run(args: string[] = []): Promise<number> {
  // Config-mode flags and --target first, so neither reaches a parser that would misread them.
  const mode = parseConfigMode(args);
  const { target, rest, error } = parseTarget(mode.rest);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }
  const takeRepo = rest.includes('--take-repo');
  if (takeRepo && rest.includes('--take-local')) {
    console.error('nortuscc: --take-repo and --take-local are mutually exclusive');
    return 2;
  }
  // apply only moves repo -> machine; keeping the local version is capture's job.
  if (rest.includes('--take-local')) {
    console.error(
      "nortuscc: --take-local has no effect on apply (apply is repo -> machine).\n" +
        "Use 'nortuscc capture --take-local' to keep the local version instead.",
    );
    return 2;
  }
  const flags = parseInstallFlags(rest);
  if (flags.error) {
    console.error(`nortuscc: ${flags.error}`);
    return 2;
  }
  const install = rest.includes('--install');
  // --skills is the compatibility alias: required skills only, and without --install, unattended.
  const skillsAlias = rest.includes('--skills');
  if (skillsAlias && !install) process.stdout.write(DEPRECATED_SKILLS);
  const targets = selectedTargets(target);

  return runCommand((signal) => Effect.gen(function* () {
    const opened = yield* openMachine({ mode });
    return yield* Effect.gen(function* () {
      const recorded = yield* recordChoice(opened, mode);
      if (recorded !== 0) return recorded;

      const { manageConfig } = resolveConfigMode(mode, opened.overrides.value);
      // A refused or unreadable file stops the run before anything is installed.
      const applied = yield* applyConfig(opened, { targets, takeRepo, manageConfig, signal });
      if (applied !== 0 || !(install || skillsAlias)) return applied;

      const declined = skillsAlias ? [...new Set([...flags.declined, 'hooks', 'mcp', 'plugins'] as const)] : flags.declined;
      return yield* runInstall(opened, {
        targets,
        flags: { ...flags, declined, yes: flags.yes || !install },
        isTTY: Boolean(process.stdin.isTTY),
        signal,
      });
    }).pipe(Effect.provide(opened.layer));
  }));
}

// Records --skills-only / --no-skills-only in overrides.json before anything is planned, and moves
// a never-migrated machine's choice out of state.json. Returns 1 when overrides.json is invalid.
const recordChoice = (opened: Opened, mode: ReturnType<typeof parseConfigMode>) =>
  Effect.gen(function* () {
    const overridesPath = join(opened.paths.stateRoot, 'overrides.json');
    // Read from state.json's legacy fields: the first state write carries them into overrides.json.
    if (opened.overrides.source !== overridesPath && Object.keys(opened.overrides.value).length > 0) {
      yield* (yield* StateStore).update((state) => state);
    }
    const next = persisted(mode, opened.overrides.value);
    if (next === undefined) return 0;
    if (opened.overrides.issues.length > 0) {
      console.error(`nortuscc: ${opened.overrides.source} is not valid, so the choice was not recorded; fix it by hand.`);
      return 1;
    }
    yield* (yield* OverridesStore).write(next);
    return 0;
  });
