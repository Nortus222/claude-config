import { decodeConnections, type ConnectionResult, type ConnectionTarget } from '../shared/mcp-connections-protocol.ts';
import type { Bridge } from './bridge.ts';
import type { MachineController } from './controller.ts';
type Operation = { action: 'inspect' | 'connect' | 'disconnect'; target?: ConnectionTarget };
export type ConnectionsViewState = { connections: readonly ConnectionResult[]; pending: boolean; available: boolean; detail: string; operation: Operation | null; unverified: readonly ConnectionTarget[] };
const targets = ['codex', 'claude'] as const;

// Session fencing drops replies from an old app connection; requests contain fixed actions only.
export class ConnectionsController {
  state: ConnectionsViewState = { connections: [], pending: false, available: false, detail: '', operation: null, unverified: targets };
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
        this.epoch++; this.update({ connections: [], pending: false, operation: null, unverified: targets, detail: '' });
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
    if (action !== 'inspect' && (!target || this.state.unverified.includes(target) || !this.state.connections.some(c => c.target === target))) return Promise.resolve();
    const token = this.machine.sessionToken(); const epoch = this.epoch;
    const current = () => !this.disposed && this.epoch === epoch && this.machine.ownsSession(token);
    this.update({ pending: true, operation: { action, target }, detail: '' });
    this.queue = this.queue.then(async () => {
      if (!current()) return;
      try {
        const response = await this.bridge!.invoke('mcp_connections', action === 'inspect' ? { action } : { action, target });
        if (!current()) return;
        if (!this.machine.ownsSession(token, response)) throw new Error('Unverified connection reply');
        const decoded = decodeConnections(response.data);
        if (new Set(decoded.connections.map(c => c.target)).size !== decoded.connections.length
          || action !== 'inspect' && (decoded.connections.length !== 1 || decoded.connections[0]?.target !== target)) throw new Error('Invalid connection reply');
        const connections = action === 'inspect' ? decoded.connections
          : [...this.state.connections.filter(c => c.target !== target), ...decoded.connections];
        this.update({ connections, unverified: action === 'inspect' ? targets.filter(t => !connections.some(c => c.target === t)) : this.state.unverified.filter(t => t !== target) });
      } catch {
        if (current()) this.update({
          detail: action === 'inspect' ? "Couldn't check connections. Try checking again before making changes."
            : `Couldn't confirm the ${target === 'codex' ? 'Codex' : 'Claude Code'} ${action === 'connect' ? 'connection' : 'disconnect'}. Local configuration may have changed. Check again before retrying.`,
          unverified: action === 'inspect' ? targets : [...new Set([...this.state.unverified, target!])],
        });
      } finally { if (current()) this.update({ pending: false, operation: null }); }
    });
    return this.queue;
  }
  refresh = () => this.run('inspect');
  connect = (target: ConnectionTarget) => this.run('connect', target);
  disconnect = (target: ConnectionTarget) => this.run('disconnect', target);
  dispose() { this.epoch++; this.disposed = true; this.unlisten(); this.listeners.clear(); }
}
