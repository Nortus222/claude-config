import type { ResolvedFile } from '@nortuscc/profile-engine';
import { configFileId, splitOutcome, type MachineReport, type Plan } from '@nortuscc/machine';
import type { Ran } from './machine.ts';

// apply and capture plan per item (a settings key is its own item) but report per file. This folds a
// run's items back into one outcome per managed file, which each command renders as its own row.

export const CONFLICT_NOTE = 'conflict — nothing changed';
export const UNPARSEABLE_NOTE = 'could not be parsed as JSON — fix it by hand, then re-run';

// A config item key's settings key: `config:claude:settings.json#theme` -> `theme`.
export const settingsKeyOf = (key: string): string | undefined => (key.includes('#') ? key.slice(key.indexOf('#') + 1) : undefined);

export type FileOutcome = {
  file: ResolvedFile;
  // At least one of the file's items was written.
  copied: boolean;
  // `backed up -> <path>` for the first write that displaced something, else ''.
  backupNote: string;
  // Steps that did not finish ok, with the settings key (or item key) they were for.
  failures: Array<{ key: string; outcome: 'failed' | 'cancelled'; note: string }>;
  unparseable: boolean;
  // Settings keys (or item keys, for a whole file) skipped as conflicts.
  conflicts: string[];
  // Why a file blocked in the repo (missing-repo, invalid) was skipped.
  blocked?: string;
};

export function fileOutcomes(files: ReadonlyArray<ResolvedFile>, report: MachineReport, planned: Plan, ran: Ran | undefined): FileOutcome[] {
  const stateOf = (key: string) => report.items.find((i) => i.key === key)?.state;
  return files.map((file) => {
    const mine = <T extends { key: string }>(entries: ReadonlyArray<T>) => entries.filter((e) => configFileId(e.key) === file.id);
    const results = mine((ran?.results ?? []).map((r) => ({ ...r, key: r.step.key })));
    const skipped = mine(planned.skipped);
    const copied = results.filter((r) => r.outcome === 'ok' && splitOutcome(r.note).action === 'copied');
    const backedUp = copied.map((r) => splitOutcome(r.note).backedUp).find(Boolean);
    const blocked = skipped.find((s) => ['missing-repo', 'invalid'].includes(stateOf(s.key) ?? ''));
    return {
      file,
      copied: copied.length > 0,
      backupNote: backedUp ? `backed up -> ${backedUp}` : '',
      failures: results.flatMap((r) => (r.outcome === 'ok' ? [] : [{ key: settingsKeyOf(r.key) ?? r.key, outcome: r.outcome, note: r.note }])),
      unparseable: skipped.some((s) => stateOf(s.key) === 'unparseable-local'),
      conflicts: skipped.filter((s) => stateOf(s.key) === 'conflict').map((s) => settingsKeyOf(s.key) ?? s.key),
      ...(blocked ? { blocked: blocked.reason } : {}),
    };
  });
}
