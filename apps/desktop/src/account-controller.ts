import { Schema } from 'effect';
import { DisplayNameSchema, MachinePatchSchema, type MachinePatch, type Policy } from '@nortuscc/hosted-protocol';
import { decodeHostedState, decodeSignInResult, type WireHostedState } from '@nortuscc/agent/ipc/protocol';
import type { Bridge, Command } from './bridge.ts';
import type { MachineController } from './controller.ts';

export type AccountTimers = { now(): number; set(callback: () => void, delay: number): unknown; clear(timer: unknown): void };
const timers: AccountTimers = { now: () => Date.now(), set: (callback, delay) => setTimeout(callback, delay), clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) };
type Code = ReturnType<typeof decodeSignInResult>;
export type AccountViewState = {
  readonly hosted: WireHostedState | null;
  readonly code: Code | null;
  readonly flow: 'idle' | 'pending' | 'success' | 'expired' | 'cancelled' | 'error';
  readonly reportStatus: boolean;
  readonly pending: boolean;
  readonly detail: string;
};
const opened = Schema.decodeUnknownSync(Schema.Struct({ opened: Schema.Literal(true) }), { onExcessProperty: 'error' });

// Serial account actions share the machine connection fence; codes and timers remain transient.
export class AccountController {
  state: AccountViewState = { hosted: null, code: null, flow: 'idle', reportStatus: false, pending: false, detail: '' };
  private bridge: Bridge | null;
  private machine: MachineController;
  private timers: AccountTimers;
  private listeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private epoch = 0;
  private disposed = false;
  private outstanding = 0;
  private timer: unknown;
  private expiresAt = 0;
  private pendingInterval = 5000;
  private unlisten: () => void;
  constructor(bridge: Bridge | null, machine: MachineController, clock: AccountTimers = timers) {
    this.bridge = bridge; this.machine = machine; this.timers = clock;
    let session = machine.state.session;
    let connected = machine.state.connection === 'connected';
    this.unlisten = machine.subscribe(() => {
      const nextConnected = machine.state.connection === 'connected';
      if (session !== machine.state.session || (connected && !nextConnected)) {
        this.invalidate();
        this.update({ hosted: null, code: null, flow: 'idle', pending: false, detail: 'Reconnect the local agent to manage this account.' });
      }
      session = machine.state.session; connected = nextConnected;
    });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  idle = () => this.queue;
  private update(fields: Partial<AccountViewState>) { if (this.disposed) return; this.state = { ...this.state, ...fields }; for (const listener of this.listeners) listener(); }
  private stopTimer() { if (this.timer !== undefined) this.timers.clear(this.timer); this.timer = undefined; }
  private invalidate() { this.epoch++; this.stopTimer(); this.expiresAt = 0; }
  private ready() { return !!this.bridge && this.machine.state.connection === 'connected' && !this.disposed; }
  private serial(action: (current: (reply?: { generation: number }) => boolean, token: ReturnType<MachineController['sessionToken']>) => Promise<void>) {
    if (!this.ready()) return Promise.resolve();
    const epoch = this.epoch;
    const token = this.machine.sessionToken();
    const current = (reply?: { generation: number }) => !this.disposed && this.epoch === epoch && this.machine.ownsSession(token, reply ? { ...reply, data: null } : undefined);
    this.outstanding++;
    this.update({ pending: true });
    this.queue = this.queue.then(async () => {
      if (!current()) return;
      try { await action(current, token); }
      catch { if (current()) { this.stopTimer(); this.update({ code: null, flow: 'error', detail: 'Account action failed. Retry or reconnect the local agent.' }); } }
    }).finally(() => {
      this.outstanding--;
      if (!this.disposed) this.update({ pending: this.ready() && this.outstanding > 0 });
    });
    return this.queue;
  }
  chooseReporting(reportStatus: boolean) { if (!this.state.pending && this.state.flow !== 'pending') this.update({ reportStatus }); }
  private accept(hosted: WireHostedState, detail?: string) {
    const previous = this.state.hosted;
    const changedAccount = previous?.accountId !== null && previous?.accountId !== undefined && previous.accountId !== hosted.accountId;
    if (changedAccount) this.invalidate();
    const authenticated = hosted.auth === 'signed-in';
    const pending = hosted.signingIn && !authenticated;
    if (!pending) { this.stopTimer(); this.expiresAt = 0; }
    const flow = changedAccount && !authenticated ? 'idle' : authenticated && (this.state.flow === 'pending' || this.state.flow === 'expired') ? 'success'
      : pending ? 'pending' : this.state.flow === 'pending' ? (hosted.error === 'sign_in_expired' ? 'expired' : 'error') : this.state.flow;
    this.update({ hosted, flow, ...(pending && !changedAccount ? {} : { code: null }), detail: detail ?? (authenticated ? 'Signed in.' : pending ? 'Waiting for GitHub authorization.' : hosted.auth === 'unauthenticated' ? 'Account authorization expired. Sign in again.' : hosted.enabled ? 'Sign in is optional. Local review remains available.' : 'Hosted accounts are disabled for this agent.') });
    if (pending && !changedAccount) this.schedule();
  }
  private schedule() {
    this.stopTimer();
    if (!this.ready() || this.state.flow !== 'pending') return;
    const retry = this.state.hosted?.retryAt ? Date.parse(this.state.hosted.retryAt) - this.timers.now() : 0;
    const untilExpiry = this.expiresAt ? this.expiresAt - this.timers.now() : 60_000;
    const delay = Math.max(1, Math.min(60_000, untilExpiry, Math.max(1000, this.pendingInterval, retry)));
    const epoch = this.epoch;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      if (this.disposed || epoch !== this.epoch || !this.ready()) return;
      if (this.expiresAt && this.timers.now() >= this.expiresAt) {
        this.invalidate();
        this.update({ code: null, flow: 'expired', detail: 'GitHub code expired. Sign in again.' });
        void this.serial(async (current) => {
          const reply = await this.bridge!.invoke('hosted_state');
          if (!current(reply)) return;
          const hosted = decodeHostedState(reply.data);
          this.accept(hosted);
          if (hosted.auth !== 'signed-in') {
            this.stopTimer();
            this.update({ code: null, flow: 'expired', detail: 'GitHub code expired. Refresh account state or sign in again.' });
          }
        });
        return;
      }
      void this.refresh();
    }, delay);
  }
  refresh() {
    return this.serial(async (current) => {
      const reply = await this.bridge!.invoke('hosted_state');
      if (current(reply)) this.accept(decodeHostedState(reply.data));
    });
  }
  signIn(name?: string) {
    if (this.state.pending || this.state.flow === 'pending' || this.state.hosted?.auth === 'signed-in' || this.state.hosted?.enabled !== true) return Promise.resolve();
    return this.serial(async (current) => {
      if (name !== undefined) Schema.decodeUnknownSync(DisplayNameSchema)(name);
      const reply = await this.bridge!.invoke('sign_in', { ...(name ? { name } : {}), reportStatus: this.state.reportStatus });
      if (!current(reply)) return;
      const code = decodeSignInResult(reply.data);
      this.expiresAt = this.timers.now() + Math.min(code.expiresIn * 1000, 900_000);
      this.pendingInterval = Math.min(60_000, code.interval * 1000);
      this.update({ code, flow: 'pending', detail: 'Enter this code on GitHub. Authorization is still pending.' });
      this.schedule();
    });
  }
  signOut() {
    if (!this.ready()) return Promise.resolve();
    this.invalidate();
    this.update({ code: null, flow: 'cancelled', detail: 'Signing out and cancelling pending authorization.' });
    return this.serial(async (current) => {
      const reply = await this.bridge!.invoke('sign_out');
      if (current(reply)) this.accept(decodeHostedState(reply.data), 'Signed out. Local review remains available.');
    });
  }
  openGitHub() {
    if (this.state.flow !== 'pending' || !this.state.code || this.state.pending) return Promise.resolve();
    return this.serial(async (current) => {
      const reply = await this.bridge!.invoke('open_device_login');
      if (current(reply)) { opened(reply.data); this.update({ detail: 'GitHub opened. Enter the code to authorize this Mac.' }); }
    });
  }
  private mutation(command: Command, args: Readonly<Record<string, unknown>> | undefined, detail: string) {
    if (this.state.pending || this.state.hosted?.auth !== 'signed-in') return Promise.resolve();
    return this.serial(async (current) => {
      const reply = await this.bridge!.invoke(command, args);
      if (current(reply)) this.accept(decodeHostedState(reply.data), detail);
    });
  }
  syncNow() { return this.mutation('sync_now', undefined, 'Sync requested. Check the last successful sync and any retry below.'); }
  machineSettings(patch: MachinePatch) {
    try { Schema.decodeUnknownSync(MachinePatchSchema, { onExcessProperty: 'error' })(patch); }
    catch { this.update({ detail: 'Enter valid machine settings.' }); return Promise.resolve(); }
    return this.mutation('machine_settings', { patch }, 'Machine settings queued. The displayed settings include local pending changes.');
  }
  trustSetup(setupId: string, consent: boolean) {
    if (!consent || !this.state.hosted?.setups.some((setup) => setup.setupId === setupId)) return Promise.resolve();
    return this.mutation('trust_setup', { setupId }, 'Trust request acknowledged for this Mac. Repeating it is safe.');
  }
  setPolicy(policy: Policy) {
    if (this.state.pending) return Promise.resolve();
    return this.serial(async (current, token) => {
      const reply = await this.bridge!.invoke('set_policy', { policy });
      if (current(reply)) { this.machine.acceptStatus(token, reply); this.update({ detail: 'Policy updated. Any automatic apply pause remains until Resume.' }); }
    });
  }
  resume() {
    if (this.state.pending || !this.machine.state.status?.paused) return Promise.resolve();
    return this.serial(async (current, token) => {
      const reply = await this.bridge!.invoke('resume_agent');
      if (current(reply)) { this.machine.acceptStatus(token, reply); this.update({ detail: 'Resume requested.' }); }
    });
  }
  dispose() {
    this.invalidate();
    this.update({ hosted: null, code: null, flow: 'idle', pending: false });
    this.disposed = true;
    this.unlisten();
    this.listeners.clear();
  }
}
