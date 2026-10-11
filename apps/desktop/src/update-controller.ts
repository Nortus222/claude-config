import { decodeUpdateSnapshot, type UpdateCommand, type UpdateSnapshot } from '../shared/update-protocol.ts';

export interface UpdateBridge {
  invoke(command: UpdateCommand, args?: { automatic: boolean } | { automaticChecks: boolean }): Promise<UpdateSnapshot>;
}
export type UpdateViewState = {
  readonly native: boolean;
  readonly update: UpdateSnapshot | null;
  readonly pending: boolean;
  readonly retry: 'check' | 'download' | 'install' | null;
  readonly detail: string;
  readonly deferred: boolean;
};
const activePhases = new Set<UpdateSnapshot['phase']>(['checking', 'downloading', 'waiting', 'installing', 'restarting']);
const schedulePoll = (callback: () => void) => { const timer = setTimeout(callback, 500); return () => clearTimeout(timer); };

// Update operations have their own lifecycle, independent of setup and agent IPC.
export class UpdateController {
  state: UpdateViewState;
  private listeners = new Set<() => void>();
  private disposed = false;
  private started = false;
  private revision = 0;
  private stopPoll: (() => void) | null = null;
  private active: Promise<void> | null = null;
  private command: UpdateCommand | null = null;
  private bridge: UpdateBridge | null;
  private schedule: typeof schedulePoll;
  constructor(bridge: UpdateBridge | null, schedule = schedulePoll) {
    this.bridge = bridge;
    this.schedule = schedule;
    this.state = { native: bridge !== null, update: null, pending: false, retry: null, deferred: false,
      detail: bridge ? 'Reading update state.' : 'Browser preview. Native update actions are disabled.' };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private publish(fields: Partial<UpdateViewState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...fields };
    for (const listener of this.listeners) listener();
  }
  private owns(revision: number) { return !this.disposed && revision === this.revision; }
  private busy() { return this.state.pending || (this.state.update !== null && activePhases.has(this.state.update.phase)); }
  private available() { return !this.disposed && this.bridge !== null && this.state.update?.enabled === true; }
  private accept(update: UpdateSnapshot, retry: UpdateViewState['retry']) {
    this.publish({ update, detail: '', retry: update.phase === 'error' ? retry : null });
  }
  private poll() {
    this.stopPoll?.(); this.stopPoll = null;
    if (this.disposed || !this.bridge || !this.busy()) return;
    const revision = this.revision;
    this.stopPoll = this.schedule(() => {
      this.stopPoll = null;
      void this.bridge!.invoke('update_state').then((reply) => {
        if (this.owns(revision)) this.accept(decodeUpdateSnapshot(reply), this.state.retry);
      }).catch(() => {
        if (this.owns(revision)) this.publish({ detail: 'Could not read update progress.' });
      }).finally(() => { if (this.owns(revision)) this.poll(); });
    });
  }
  async start() {
    if (this.started || !this.bridge || this.disposed) return;
    this.started = true;
    await this.request('update_state', undefined, 'check');
    if (this.available() && this.state.update?.automaticChecks && !this.busy()) await this.check(true);
  }
  private request(command: UpdateCommand, args: Parameters<UpdateBridge['invoke']>[1], retry: UpdateViewState['retry']): Promise<void> {
    if (!this.bridge || this.disposed) return Promise.resolve();
    if (this.active) return this.active;
    const revision = ++this.revision;
    this.command = command;
    this.publish({ pending: true, detail: '', retry: null, deferred: false });
    this.poll();
    const action = (async () => {
      try {
        const reply = await this.bridge!.invoke(command, args);
        if (this.owns(revision)) this.accept(decodeUpdateSnapshot(reply), retry);
      } catch {
        if (this.owns(revision)) this.publish({ detail: 'Update action failed. Retry when ready.', retry });
      } finally {
        if (this.owns(revision)) {
          // Invalidate progress reads started before the command's final snapshot.
          this.revision++;
          this.active = null; this.command = null;
          this.publish({ pending: false });
          this.poll();
        }
      }
    })();
    this.active = action;
    return action;
  }
  async check(automatic = false) {
    if (this.disposed || !this.bridge) return;
    if (!this.state.update) await this.request('update_state', undefined, 'check');
    if (!this.available()) return;
    if (this.active) return this.active;
    if (this.busy()) return Promise.resolve();
    return this.request('check_update', { automatic }, 'check');
  }
  download() {
    if (!this.available()) return Promise.resolve();
    if (this.active) return this.active;
    if (this.busy() || !this.state.update?.availableVersion || !['available', 'error'].includes(this.state.update.phase)) return Promise.resolve();
    return this.request('download_update', undefined, 'download');
  }
  install() {
    if (!this.available()) return Promise.resolve();
    if (this.active) return this.active;
    if (this.busy() || (this.state.update?.phase !== 'verified' && !(this.state.update?.phase === 'error' && this.state.retry === 'install'))) return Promise.resolve();
    return this.request('install_update', undefined, 'install');
  }
  cancel() {
    if (this.command === 'cancel_update' && this.active) return this.active;
    if (!this.available() || !['downloading', 'waiting'].includes(this.state.update!.phase)) return Promise.resolve();
    // Cancellation must bypass the outstanding download or install-wait request.
    this.revision++; this.active = null;
    return this.request('cancel_update', undefined, null);
  }
  preferences(automaticChecks: boolean) {
    if (!this.available() || this.busy()) return Promise.resolve();
    return this.request('update_preferences', { automaticChecks }, 'check');
  }
  retry() {
    return this.state.retry === 'download' ? this.download() : this.state.retry === 'install' ? this.install() : this.check();
  }
  defer() { if (!this.busy()) this.publish({ deferred: true }); }
  show() { this.publish({ deferred: false }); }
  dispose() { this.disposed = true; this.revision++; this.stopPoll?.(); this.stopPoll = null; this.listeners.clear(); }
}
