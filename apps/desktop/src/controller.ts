import { inspectFixture, type Fixture } from '../backend/fixture.ts';
import type { Progress } from '../backend/protocol.ts';
import { decodeFixture, type Bridge, type Command, type HostEvent } from './bridge.ts';
export type ViewState = {
  connection: 'connecting' | 'connected' | 'disconnected' | 'browser';
  fixture: Fixture;
  operation: Progress | null;
  pending: boolean;
  detail: string;
};
/** Coordinates the narrow bridge and ignores events from old processes or operations. */
export class FixtureController {
  state: ViewState = {
    connection: 'connecting',
    fixture: inspectFixture(),
    operation: null,
    pending: false,
    detail: 'Connecting to the bundled backend',
  };
  private generation: number | null = null;
  private disposed = false;
  private unlisten?: () => void;
  private listeners = new Set<() => void>();
  private early = new Map<string, Progress>();
  private starting = false;
  constructor(private bridge: Bridge | null) {
    if (!bridge)
      this.state = {
        ...this.state,
        connection: 'browser',
        detail: 'Browser preview. Open the desktop app to run fixture operations.',
      };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  private update(update: Partial<ViewState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  async connect() {
    if (!this.bridge) return;
    try {
      const unlisten = await this.bridge.subscribe((event) => this.receive(event));
      if (this.disposed) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
      const reply = await this.bridge.invoke('inspect_fixture');
      if (this.disposed) return;
      this.generation = reply.generation;
      this.update({
        fixture: decodeFixture(reply.data),
        connection: 'connected',
        detail: 'Bundled backend connected',
      });
    } catch (error) {
      this.update({ connection: 'disconnected', detail: String(error) });
    }
  }
  private receive(event: HostEvent) {
    if (event.generation !== this.generation || this.disposed) return;
    if (event.event === 'disconnected') {
      this.starting = false;
      this.early.clear();
      this.update({ connection: 'disconnected', pending: false, detail: event.detail });
      return;
    }
    if (this.starting) {
      if (this.early.size < 8 || this.early.has(event.operationId))
        this.early.set(event.operationId, event);
      return;
    }
    if (
      event.operationId !== this.state.operation?.operationId ||
      this.state.operation.state !== 'running'
    )
      return;
    this.update({ operation: event, detail: event.detail });
    if (event.state === 'completed') void this.refresh();
  }
  private async refresh() {
    try {
      const reply = await this.bridge!.invoke('inspect_fixture');
      if (reply.generation === this.generation && this.state.connection === 'connected')
        this.update({ fixture: decodeFixture(reply.data) });
    } catch (error) {
      this.update({ detail: String(error) });
    }
  }
  async start() {
    if (
      !this.bridge ||
      this.state.connection !== 'connected' ||
      this.state.pending ||
      this.state.operation?.state === 'running'
    )
      return;
    this.starting = true;
    this.early.clear();
    this.update({ pending: true, operation: null, detail: 'Starting fixture operation' });
    try {
      const reply = await this.bridge.invoke('start_fixture');
      if (reply.generation !== this.generation || this.state.connection !== 'connected') return;
      const id = (reply.data as { operationId?: unknown }).operationId;
      if (typeof id !== 'string' || !id) throw new Error('Invalid operation acknowledgement');
      this.update({
        operation: {
          version: 1,
          event: 'progress',
          operationId: id,
          state: 'running',
          percent: 0,
          detail: 'Preparing fixture',
        },
      });
      this.starting = false;
      const buffered = this.early.get(id);
      this.early.clear();
      if (buffered) this.receive({ ...buffered, generation: reply.generation });
    } catch (error) {
      this.update({ detail: String(error) });
    } finally {
      this.starting = false;
      this.update({ pending: false });
    }
  }
  async cancel() {
    await this.command('cancel_fixture');
  }
  async crash() {
    await this.command('crash_probe');
  }
  private async command(command: Command) {
    if (!this.bridge || this.state.pending || this.state.connection !== 'connected') return;
    this.update({ pending: true });
    try {
      await this.bridge.invoke(command);
    } catch (error) {
      this.update({ detail: String(error) });
    } finally {
      this.update({ pending: false });
    }
  }
  async restart() {
    if (!this.bridge || this.state.pending) return;
    this.generation = null;
    this.starting = false;
    this.early.clear();
    this.update({
      pending: true,
      connection: 'connecting',
      operation: null,
      detail: 'Starting a fresh backend',
    });
    try {
      const reply = await this.bridge.invoke('restart_backend');
      this.generation = reply.generation;
      this.update({
        fixture: decodeFixture(reply.data),
        connection: 'connected',
        detail: 'Fresh backend connected. Fixture reset.',
      });
    } catch (error) {
      this.update({ connection: 'disconnected', detail: String(error) });
    } finally {
      this.update({ pending: false });
    }
  }
  dispose() {
    this.disposed = true;
    this.unlisten?.();
    this.listeners.clear();
  }
}
