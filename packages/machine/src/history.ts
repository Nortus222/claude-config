import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import type { FsFailed } from './errors.ts';
import { Fs } from './fs.ts';
import { MachinePaths } from './paths.ts';

// Who acted. `sync` marks another of the user's machines, whose event also carries its machineId.
export type Actor = 'agent' | 'cli' | 'app' | 'sync';
export type ItemReason = { readonly itemId: string; readonly reason: string };
export type StepRecord = { readonly key: string; readonly outcome: 'ok' | 'failed' | 'cancelled'; readonly note: string };

// What a writer supplies; the store stamps `v` and `at`. Issues that write further kinds
// (restore, setup-linked, sync-failed, outbox-dropped) add them here.
export type HistoryEventBody =
  | { readonly kind: 'apply-started'; readonly runId: string; readonly automatic: boolean; readonly keys: ReadonlyArray<string> }
  | {
    readonly kind: 'apply-finished'; readonly runId: string; readonly steps: ReadonlyArray<StepRecord>;
    readonly backup: string | null; readonly result: 'done' | 'cancelled';
    // Set only when reading: the folder was pruned, so `backup` reads 'pruned'.
    readonly prunedFolder?: string; readonly prunedAt?: string;
  }
  | { readonly kind: 'held' | 'ready'; readonly items: ReadonlyArray<ItemReason> }
  | {
    readonly kind: 'decided'; readonly setupId: string; readonly itemId: string;
    readonly revision: number | null; readonly commit: string | null; readonly decision: 'accept' | 'skip';
  }
  | { readonly kind: 'policy-changed'; readonly from: string; readonly to: string; readonly origin: 'local' | 'synced' }
  | { readonly kind: 'setup-trusted'; readonly setupId: string | null; readonly repoUrl: string | null }
  | { readonly kind: 'paused'; readonly reason: string; readonly runId?: string }
  | { readonly kind: 'resumed'; readonly reason: string }
  | { readonly kind: 'revision-verified' | 'revision-rejected'; readonly setupId: string; readonly revision: string; readonly error?: string }
  | { readonly kind: 'backups-pruned'; readonly folders: ReadonlyArray<string> }
  | { readonly kind: 'outbox-dropped'; readonly accountId: string; readonly count: number; readonly code: 'invalid' };

export type HistoryInput = HistoryEventBody & { readonly actor: Actor; readonly machineId?: string };
export type HistoryEvent = HistoryInput & { readonly v: 1; readonly at: string };

// Append-only History, shared by the agent and the CLI.
export class HistoryStore extends Context.Service<
  HistoryStore,
  {
    readonly append: (event: HistoryInput) => Effect.Effect<void, FsFailed>;
    // Every event, oldest first. An apply-finished whose folder was pruned reads `backup: 'pruned'`.
    readonly read: Effect.Effect<ReadonlyArray<HistoryEvent>, FsFailed>;
  }
>()('machine/HistoryStore') {}

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;

// A line that does not parse is an append cut short by a crash (or a hand edit): skipped, never fatal.
const parseLines = (text: string): HistoryEvent[] =>
  text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value: unknown = JSON.parse(line);
      const isEvent = typeof value === 'object' && value !== null && !Array.isArray(value)
        && typeof (value as { kind?: unknown }).kind === 'string';
      return isEvent ? [value as HistoryEvent] : [];
    } catch {
      return [];
    }
  });

const markPruned = (events: ReadonlyArray<HistoryEvent>): HistoryEvent[] => {
  const prunedAt = new Map<string, string>();
  for (const e of events) if (e.kind === 'backups-pruned') for (const folder of e.folders) prunedAt.set(folder, e.at);
  return events.map((e): HistoryEvent =>
    e.kind === 'apply-finished' && e.backup !== null && prunedAt.has(e.backup)
      ? { ...e, backup: 'pruned', prunedFolder: e.backup, prunedAt: prunedAt.get(e.backup)! }
      : e);
};

// <stateRoot>/history/<YYYY-MM>.jsonl, one line per event. `now` stamps events and picks the month.
export const historyStore = (now: () => Date = () => new Date()) =>
  Layer.effect(
    HistoryStore,
    Effect.gen(function* () {
      const paths = yield* MachinePaths;
      const fs = yield* Fs;
      const dir = join(paths.stateRoot, 'history');
      return {
        append: (input: HistoryInput) =>
          Effect.gen(function* () {
            const at = now().toISOString();
            const path = join(dir, `${at.slice(0, 7)}.jsonl`);
            const before = yield* fs.readText(path);
            // A torn last line is ended first, so this event never lands glued onto it.
            const lead = before !== undefined && before !== '' && !before.endsWith('\n') ? '\n' : '';
            yield* fs.appendText(path, `${lead}${JSON.stringify({ v: 1, at, ...input })}\n`);
          }),
        read: Effect.gen(function* () {
          const names = ((yield* fs.list(dir)) ?? []).filter((name) => MONTH_FILE.test(name));
          const events: HistoryEvent[] = [];
          for (const name of names) events.push(...parseLines((yield* fs.readText(join(dir, name))) ?? ''));
          return markPruned(events);
        }),
      };
    }),
  );
