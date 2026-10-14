import { decodeConnections, type ConnectionResult, type ConnectionTarget } from '../shared/mcp-connections-protocol.ts';
import type { Bridge } from './bridge.ts';
import type { MachineController } from './controller.ts';
export type ConnectionsViewState = { connections: readonly ConnectionResult[]; pending: boolean; available: boolean; detail: string };

// Session fencing drops replies from an old app connection; requests contain fixed actions only.
export class ConnectionsController {
  state: ConnectionsViewState = { connections: [], pending: false, available: false, detail: '' };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();
  private unlisten: () => void;
  private bridge: Bridge | null;
  private machine: MachineController;
  constructor(bridge: Bridge | null, machine: MachineController) {
    this.bridge = bridge; this.machine = machine;
    let session = machine.state.session;
    this.unlisten = machine.subscribe(() => {
      const available = !!bridge && machine.state.connection === 'connected';
      if (session !== machine.state.session || !available) {
        this.epoch++; this.update({ connections: [], pending: false });
      }
      session = machine.state.session; this.update({ available });
    });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(patch: Partial<ConnectionsViewState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener();
  }
  private run(action: 'inspect' | 'connect' | 'disconnect', target?: ConnectionTarget) {
    if (!this.bridge || this.disposed || !this.state.available || this.state.pending) return Promise.resolve();
    const token = this.machine.sessionToken(); const epoch = this.epoch;
    const current = () => !this.disposed && this.epoch === epoch && this.machine.ownsSession(token);
    this.update({ pending: true, detail: '' });
    this.queue = this.queue.then(async () => {
      if (!current()) return;
      try {
        const response = await this.bridge!.invoke('mcp_connections', action === 'inspect' ? { action } : { action, target });
        if (!current() || !this.machine.ownsSession(token, response)) return;
        const decoded = decodeConnections(response.data);
        if (new Set(decoded.connections.map(c => c.target)).size !== decoded.connections.length
          || action !== 'inspect' && (decoded.connections.length !== 1 || decoded.connections[0]?.target !== target)) throw new Error('Invalid connection reply');
        const connections = action === 'inspect' ? decoded.connections
          : [...this.state.connections.filter(c => c.target !== target), ...decoded.connections];
        this.update({ connections });
      } catch { if (current()) this.update({ detail: 'Connection action could not be verified. Refresh to inspect its current state.' }); }
      finally { if (current()) this.update({ pending: false }); }
    });
    return this.queue;
  }
  refresh = () => this.run('inspect');
  connect = (target: ConnectionTarget) => this.run('connect', target);
  disconnect = (target: ConnectionTarget) => this.run('disconnect', target);
  dispose() { this.epoch++; this.disposed = true; this.unlisten(); this.listeners.clear(); }
}
