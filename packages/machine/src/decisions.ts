import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { DecisionsInvalid, type FsFailed } from './errors.ts';
import { Fs } from './fs.ts';
import { MachinePaths } from './paths.ts';

// A person's current accept or skip for one item of one setup. Exactly one of `revision` (a hosted
// record's number, P3) and `commit` (a SHA, P2) is set. `setupId` is the hosted id, or 'local'.
export type Decision = {
  readonly setupId: string;
  readonly itemId: string;
  readonly revision: number | null;
  readonly commit: string | null;
  readonly decision: 'accept' | 'skip';
  readonly decidedAt: string;
  readonly machineId: string | null;
  readonly source: 'local' | 'synced';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isDecision = (value: unknown): value is Decision => {
  if (!isRecord(value)) return false;
  const byRevision = typeof value.revision === 'number' && Number.isInteger(value.revision) && value.commit === null;
  const byCommit = typeof value.commit === 'string' && value.commit !== '' && value.revision === null;
  return typeof value.setupId === 'string' && value.setupId !== ''
    && typeof value.itemId === 'string' && value.itemId !== ''
    && (byRevision || byCommit)
    && (value.decision === 'accept' || value.decision === 'skip')
    && typeof value.decidedAt === 'string' && !Number.isNaN(Date.parse(value.decidedAt))
    && (value.machineId === null || typeof value.machineId === 'string')
    && (value.source === 'local' || value.source === 'synced');
};

// All or nothing, like overrides: one unreadable decision makes the file the person's to fix.
const decode = (text: string | undefined, path: string): Effect.Effect<ReadonlyArray<Decision>, DecisionsInvalid> => {
  if (text === undefined) return Effect.succeed([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return Effect.fail(new DecisionsInvalid({ path, reason: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` }));
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.decisions)) {
    return Effect.fail(new DecisionsInvalid({ path, reason: 'expected { "version": 1, "decisions": [...] }' }));
  }
  const bad = parsed.decisions.findIndex((d) => !isDecision(d));
  if (bad !== -1) return Effect.fail(new DecisionsInvalid({ path, reason: `decision #${bad + 1} is malformed` }));
  return Effect.succeed(parsed.decisions as Decision[]);
};

export class DecisionsStore extends Context.Service<
  DecisionsStore,
  {
    readonly read: Effect.Effect<ReadonlyArray<Decision>, FsFailed | DecisionsInvalid>;
    // Stores `decision` unless the file holds a newer one for the same setup and item; answers whether it did.
    readonly record: (decision: Decision) => Effect.Effect<boolean, FsFailed | DecisionsInvalid>;
  }
>()('machine/DecisionsStore') {}

// <stateRoot>/decisions.json: only the current decision per setup and item; History keeps the past.
export const decisionsStore = Layer.effect(
  DecisionsStore,
  Effect.gen(function* () {
    const paths = yield* MachinePaths;
    const fs = yield* Fs;
    const path = join(paths.stateRoot, 'decisions.json');
    const read = Effect.flatMap(fs.readText(path), (text) => decode(text, path));
    return {
      read,
      record: (decision: Decision) =>
        Effect.gen(function* () {
          const current = yield* read;
          const same = (d: Decision) => d.setupId === decision.setupId && d.itemId === decision.itemId;
          const existing = current.find(same);
          if (existing && Date.parse(existing.decidedAt) > Date.parse(decision.decidedAt)) return false;
          const next = existing ? current.map((d) => (same(d) ? decision : d)) : [...current, decision];
          yield* fs.writeTextAtomic(path, JSON.stringify({ version: 1, decisions: next }, null, 2) + '\n');
          return true;
        }),
    };
  }),
);
