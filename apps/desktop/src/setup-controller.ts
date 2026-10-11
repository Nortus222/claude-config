import { Schema } from 'effect';
import { decodeHelloResult } from '@nortuscc/agent/ipc/protocol';
import { decodeSetupChoices, decodeSetupState, type SetupChoices, type SetupState } from '../shared/setup-protocol.ts';
import type { Bridge } from './bridge.ts';
import type { MachineController } from './controller.ts';

export type SetupViewState = {
  readonly phase: 'checking' | 'needed' | 'ready' | 'error' | 'browser';
  readonly setup: SetupState | null;
  readonly configTargets: SetupChoices['configTargets'];
  readonly pending: boolean;
  readonly detail: string;
};
const installerAck = Schema.decodeUnknownSync(Schema.Struct({ requested: Schema.Literal(true) }), { onExcessProperty: 'error' });
const helloEnvelope = Schema.decodeUnknownSync(Schema.Struct({ hello: Schema.Unknown }), { onExcessProperty: 'error' });

// First-run operations are available before an agent connection exists.
export class SetupController {
  state: SetupViewState = { phase: 'checking', setup: null, configTargets: ['claude', 'codex'], pending: false, detail: 'Checking local setup' };
  private listeners = new Set<() => void>();
  private revision = 0;
  private disposed = false;
  private bridge: Bridge | null;
  private machine: MachineController;
  constructor(bridge: Bridge | null, machine: MachineController) {
    this.bridge = bridge;
    this.machine = machine;
    if (!bridge) this.state = { ...this.state, phase: 'browser', detail: 'Browser preview. Native setup actions are disabled.' };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(fields: Partial<SetupViewState>) { if (this.disposed) return; this.state = { ...this.state, ...fields }; for (const listener of this.listeners) listener(); }
  private owns(revision: number) { return !this.disposed && this.revision === revision; }
  choose(configTargets: SetupChoices['configTargets']) {
    if (this.state.pending || this.state.phase === 'ready') return;
    this.update({ configTargets: decodeSetupChoices({ configTargets }).configTargets });
  }
  async check() {
    if (!this.bridge || this.state.pending) return;
    const revision = ++this.revision;
    this.update({ pending: true });
    try {
      const reply = await this.bridge.invoke('desktop_setup_state');
      if (!this.owns(revision)) return;
      const setup = decodeSetupState(reply.data);
      this.update({ setup, phase: setup.needsSetup ? 'needed' : 'ready', detail: setup.needsSetup ? 'Choose which configurations to manage.' : 'Local setup is ready.' });
      if (!setup.needsSetup) await this.machine.connect();
    } catch { if (this.owns(revision)) this.update({ phase: 'error', detail: 'Could not read the local setup. Check the existing setup and retry.' }); }
    finally { if (this.owns(revision)) this.update({ pending: false }); }
  }
  async installGit() {
    if (!this.bridge || this.state.pending || !this.state.setup?.canInstallGit || this.state.setup.gitAvailable) return;
    const revision = ++this.revision;
    this.update({ pending: true });
    try {
      const reply = await this.bridge.invoke('install_git');
      if (!this.owns(revision)) return;
      installerAck(reply.data);
      this.update({ detail: "Finish Apple's installer dialog, then recheck Git." });
    } catch { if (this.owns(revision)) this.update({ detail: 'Could not request the Git installer. Recheck Git or retry.' }); }
    finally { if (this.owns(revision)) this.update({ pending: false }); }
  }
  async bootstrap() {
    if (!this.bridge || this.state.pending || !this.state.setup?.gitAvailable || this.state.phase === 'ready') return;
    const revision = ++this.revision;
    this.update({ pending: true, detail: 'Preparing the fixed setup and background agent' });
    try {
      const reply = await this.bridge.invoke('setup_desktop', { configTargets: [...this.state.configTargets] });
      if (!this.owns(revision)) return;
      decodeHelloResult(helloEnvelope(reply.data).hello);
      this.update({ phase: 'ready', detail: 'Setup ready. Review changes before applying.' });
      await this.machine.connect();
    } catch { if (this.owns(revision)) this.update({ detail: 'Setup could not finish. Retry will reuse any completed checkout.' }); }
    finally { if (this.owns(revision)) this.update({ pending: false }); }
  }
  dispose() { this.disposed = true; this.revision++; this.listeners.clear(); }
}
