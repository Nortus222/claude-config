import { AgentSourceEnvironment, sourceEnvironment } from './operations/sources.ts';
import { Layer } from 'effect';
import {
  nodeProcessDialogue, type ProcessDialogue, decisionsStore, historyStore, machinePaths, nodeFs, nodeFileIntegrity, nodeProcesses, stateStore, overridesStore,
  type FileIntegrity, type OverridesStore, type Backups, type DecisionsStore, type Domain, type Fs, type HistoryStore, type MachinePaths, type MachinePathsValue,
  type Processes, type StateStore,
} from '@nortuscc/machine';
import { agentSkillInstaller, type AgentSkillInstaller } from './skill-installer.ts';
import { runStore, type RunStore } from './run-store.ts';
import { AgentClock, systemClock } from './clock.ts';
import { agentStateStore, type AgentStateStore } from './state.ts';
import { remoteStore, type RemoteStore } from './remote/remote-store.ts';
import { tailscaleAccess, type TailscaleAccess } from './remote/tailscale.ts';
import { followedStore, type FollowedStore, syncStore, type SyncStore, setupsStore, type SetupsStore } from '@nortuscc/sync';

export type AgentServices =
  | FollowedStore | FileIntegrity | AgentSourceEnvironment | SyncStore | AgentSkillInstaller | ProcessDialogue | OverridesStore | RunStore | MachinePaths | Fs | Processes | StateStore | HistoryStore | DecisionsStore | AgentStateStore | SetupsStore | AgentClock | RemoteStore | TailscaleAccess;

// The domains a job inspects and applies with; a fresh Backups is provided per job.
export type AgentDomain = Domain<FileIntegrity | MachinePaths | Fs | Processes | StateStore | Backups>;

// Builds a job's domains from that job's paths, whose `repo` is the snapshot it inspects (ADR 0016).
export type AgentDomains = (paths: MachinePathsValue) => ReadonlyArray<AgentDomain>;

// Every service the agent needs, built once from this machine's paths.
export const agentLayer = (
  paths: MachinePathsValue,
  options: { readonly sourceEnv?: Readonly<Record<string,string|undefined>>; readonly processes?: Layer.Layer<Processes>; readonly dialogue?: Layer.Layer<ProcessDialogue>; readonly skillInstaller?: Layer.Layer<AgentSkillInstaller>; readonly clock?: Layer.Layer<AgentClock>; readonly tailscale?: Layer.Layer<TailscaleAccess> } = {},
): Layer.Layer<AgentServices> => {
  const base = Layer.mergeAll(sourceEnvironment(options.sourceEnv), machinePaths(paths), nodeFs, nodeFileIntegrity, options.processes ?? nodeProcesses(), options.dialogue ?? nodeProcessDialogue({ env: {} }), options.skillInstaller ?? agentSkillInstaller(), options.clock ?? systemClock);
  return Layer.mergeAll(followedStore, syncStore, stateStore, overridesStore, historyStore(), decisionsStore, agentStateStore, setupsStore, runStore, remoteStore).pipe(
    Layer.provideMerge((options.tailscale ?? tailscaleAccess(process.platform)).pipe(Layer.provideMerge(base))),
  );
};
