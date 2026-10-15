import { AgentSourceEnvironment, sourceEnvironment } from './operations/sources.ts';
import { Layer } from 'effect';
import {
  nodeProcessDialogue, type ProcessDialogue, decisionsStore, historyStore, machinePaths, nodeFs, nodeProcesses, stateStore, overridesStore,
  type OverridesStore, type Backups, type DecisionsStore, type Domain, type Fs, type HistoryStore, type MachinePaths, type MachinePathsValue,
  type Processes, type StateStore,
} from '@nortuscc/machine';
import { agentSkillInstaller, type AgentSkillInstaller } from './skill-installer.ts';
import { runStore, type RunStore } from './run-store.ts';
import { AgentClock, systemClock } from './clock.ts';
import { agentStateStore, type AgentStateStore } from './state.ts';
import { syncStore, type SyncStore, setupsStore, type SetupsStore } from '@nortuscc/sync';

export type AgentServices =
  | AgentSourceEnvironment | SyncStore | AgentSkillInstaller | ProcessDialogue | OverridesStore | RunStore | MachinePaths | Fs | Processes | StateStore | HistoryStore | DecisionsStore | AgentStateStore | SetupsStore | AgentClock;

// The domains a job inspects and applies with; a fresh Backups is provided per job.
export type AgentDomain = Domain<MachinePaths | Fs | Processes | StateStore | Backups>;

// Builds a job's domains from that job's paths, whose `repo` is the snapshot it inspects (ADR 0016).
export type AgentDomains = (paths: MachinePathsValue) => ReadonlyArray<AgentDomain>;

// Every service the agent needs, built once from this machine's paths.
export const agentLayer = (
  paths: MachinePathsValue,
  options: { readonly sourceEnv?: Readonly<Record<string,string|undefined>>; readonly processes?: Layer.Layer<Processes>; readonly dialogue?: Layer.Layer<ProcessDialogue>; readonly skillInstaller?: Layer.Layer<AgentSkillInstaller>; readonly clock?: Layer.Layer<AgentClock> } = {},
): Layer.Layer<AgentServices> =>
  Layer.mergeAll(syncStore, stateStore, overridesStore, historyStore(), decisionsStore, agentStateStore, setupsStore, runStore).pipe(
    Layer.provideMerge(Layer.mergeAll(sourceEnvironment(options.sourceEnv), machinePaths(paths), nodeFs, options.processes ?? nodeProcesses(), options.dialogue ?? nodeProcessDialogue({ env: {} }), options.skillInstaller ?? agentSkillInstaller(), options.clock ?? systemClock)),
  );
