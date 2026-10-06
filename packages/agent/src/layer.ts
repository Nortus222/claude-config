import { Layer } from 'effect';
import {
  decisionsStore, historyStore, machinePaths, nodeFs, nodeProcesses, stateStore,
  type Backups, type DecisionsStore, type Domain, type Fs, type HistoryStore, type MachinePaths, type MachinePathsValue,
  type Processes, type StateStore,
} from '@nortuscc/machine';
import { AgentClock, systemClock } from './clock.ts';
import { agentStateStore, type AgentStateStore } from './state.ts';
import { setupsStore, type SetupsStore } from '@nortuscc/sync';

export type AgentServices =
  | MachinePaths | Fs | Processes | StateStore | HistoryStore | DecisionsStore | AgentStateStore | SetupsStore | AgentClock;

// The domains a job inspects and applies with; a fresh Backups is provided per job.
export type AgentDomain = Domain<MachinePaths | Fs | Processes | StateStore | Backups>;

// Every service the agent needs, built once from this machine's paths.
export const agentLayer = (
  paths: MachinePathsValue,
  options: { readonly processes?: Layer.Layer<Processes>; readonly clock?: Layer.Layer<AgentClock> } = {},
): Layer.Layer<AgentServices> =>
  Layer.mergeAll(stateStore, historyStore(), decisionsStore, agentStateStore, setupsStore).pipe(
    Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs, options.processes ?? nodeProcesses(), options.clock ?? systemClock)),
  );
