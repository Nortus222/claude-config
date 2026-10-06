import { join } from 'node:path';
import { Context, Effect, Layer, Semaphore } from 'effect';
import { Fs, MachinePaths, type FsFailed } from '@nortuscc/machine';

export type Policy = 'auto-apply' | 'notify' | 'manual';
export const POLICIES: ReadonlyArray<Policy> = ['auto-apply', 'notify', 'manual'];
export type Paused = { readonly reason: string; readonly at: string; readonly runId?: string };
export type AgentState = {
  readonly version: 1;
  readonly policy: Policy;
  readonly policySource: 'default' | 'person';
  readonly paused: Paused | null;
};

// Before sign-in a machine notifies, and records that nobody chose that yet.
export const DEFAULT_STATE: AgentState = { version: 1, policy: 'notify', policySource: 'default', paused: null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Any pause that is not a well-formed record still reads as paused: a pause must never be lost.
const pausedOf = (value: unknown): Paused | null => {
  if (value === null || value === undefined || value === false) return null;
  if (isRecord(value) && typeof value.reason === 'string' && typeof value.at === 'string') {
    return { reason: value.reason, at: value.at, ...(typeof value.runId === 'string' ? { runId: value.runId } : {}) };
  }
  return { reason: 'paused', at: '' };
};

const decode = (raw: Readonly<Record<string, unknown>>): AgentState => ({
  version: 1,
  policy: POLICIES.includes(raw.policy as Policy) ? (raw.policy as Policy) : DEFAULT_STATE.policy,
  policySource: raw.policySource === 'person' ? 'person' : 'default',
  paused: pausedOf(raw.paused),
});

export class AgentStateStore extends Context.Service<
  AgentStateStore,
  {
    readonly read: Effect.Effect<AgentState, FsFailed>;
    readonly update: (f: (state: AgentState) => AgentState) => Effect.Effect<AgentState, FsFailed>;
  }
>()('agent/AgentStateStore') {}

// <stateRoot>/agent/agent.json. A corrupt file reads as the default, as state.json does. Writes keep
// the fields other parts own (installedBy and agentVersion, written by the installer). Updates run
// one at a time, so the job's pause and a caller's policy change never overwrite each other.
export const agentStateStore = Layer.effect(
  AgentStateStore,
  Effect.gen(function* () {
    const paths = yield* MachinePaths;
    const fs = yield* Fs;
    const path = join(paths.stateRoot, 'agent', 'agent.json');
    const lock = yield* Semaphore.make(1);
    const raw = Effect.map(fs.readText(path), (text): Readonly<Record<string, unknown>> => {
      if (text === undefined) return {};
      try {
        const value: unknown = JSON.parse(text);
        return isRecord(value) ? value : {};
      } catch {
        return {};
      }
    });
    return {
      read: Effect.map(raw, decode),
      update: (f: (state: AgentState) => AgentState) =>
        Effect.gen(function* () {
          const before = yield* raw;
          const next = f(decode(before));
          yield* fs.writeTextAtomic(path, JSON.stringify({ ...before, ...next }, null, 2) + '\n');
          return next;
        }).pipe(lock.withPermit),
    };
  }),
);
