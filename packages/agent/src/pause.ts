import { Effect } from 'effect';
import { HistoryStore, type Actor, type HistoryEvent } from '@nortuscc/machine';
import { AgentClock } from './clock.ts';
import { AgentStateStore } from './state.ts';

// Stops auto-apply until a person resumes it, and says why in History. There are no automatic
// retries. Notifying about it is the Notifier's (#80).
export const pause = (reason: string, runId?: string) =>
  Effect.gen(function* () {
    const at = (yield* (yield* AgentClock).now).toISOString();
    yield* (yield* AgentStateStore).update((state) => ({ ...state, paused: { reason, at, ...(runId ? { runId } : {}) } }));
    yield* (yield* HistoryStore).append({ kind: 'paused', actor: 'agent', reason, ...(runId ? { runId } : {}) });
  });

// A person clears a pause. Answers whether there was one.
export const resume = (actor: Actor) =>
  Effect.gen(function* () {
    const store = yield* AgentStateStore;
    const before = yield* store.read;
    if (before.paused === null) return false;
    yield* store.update((state) => ({ ...state, paused: null }));
    yield* (yield* HistoryStore).append({ kind: 'resumed', actor, reason: `was paused: ${before.paused.reason}` });
    return true;
  });

// The newest automatic agent run History shows started and never finished, unless a pause already
// names it: the agent died mid-apply. Naming the run in the pause keeps a crash loop to one pause.
export const interruptedRun = (events: ReadonlyArray<HistoryEvent>): string | undefined => {
  const settled = new Set<string>();
  for (const e of events) {
    if (e.kind === 'apply-finished') settled.add(e.runId);
    if (e.kind === 'paused' && e.runId !== undefined) settled.add(e.runId);
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'apply-started' && e.actor === 'agent' && e.automatic && !settled.has(e.runId)) return e.runId;
  }
  return undefined;
};
