import { Effect } from 'effect';
import { DecisionsStore, HistoryStore, type Actor, type Decision } from '@nortuscc/machine';
import { AgentStateStore, type Policy } from './state.ts';

// Stores a decision and records it in History, which keeps the past; decisions.json keeps only the
// current one. A decision older than the stored one changes nothing and records nothing.
export const recordDecision = (decision: Decision, actor: Actor) =>
  Effect.gen(function* () {
    if (!(yield* (yield* DecisionsStore).record(decision))) return;
    const { setupId, itemId, revision, commit, machineId } = decision;
    yield* (yield* HistoryStore).append({
      kind: 'decided', actor, setupId, itemId, revision, commit, decision: decision.decision, ...(machineId ? { machineId } : {}),
    });
  });

// A person on this machine sets its policy. The classifier still holds code-running items.
export const changePolicy = (policy: Policy, actor: Actor) =>
  Effect.gen(function* () {
    const store = yield* AgentStateStore;
    const before = yield* store.read;
    if (before.policy === policy && before.policySource === 'person') return;
    yield* store.update((state) => ({ ...state, policy, policySource: 'person' }));
    if (before.policy !== policy) {
      yield* (yield* HistoryStore).append({ kind: 'policy-changed', actor, from: before.policy, to: policy, origin: 'local' });
    }
  });
