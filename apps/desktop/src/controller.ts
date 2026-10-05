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
  private revision = 0;
  private earlyDisconnects = new Map<number, Extract<HostEvent, { event: 'disconnected' }>>();
  private owns(revision: number) {
    return !this.disposed && this.revision === revision;
  }
  private establish(
    reply: { generation: number; data: unknown },
    detail: string,
    revision: number,
  ) {
    if (!this.owns(revision)) return;
    const fixture = decodeFixture(reply.data);
    this.generation = reply.generation;
    const disconnected = this.earlyDisconnects.get(reply.generation);
    this.earlyDisconnects.clear();
    if (disconnected) {
      this.revision++;
      this.update({
        fixture,
        connection: 'disconnected',
        pending: false,
        detail: disconnected.detail,
      });
    } else this.update({ fixture, connection: 'connected', detail });
  }
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
    const revision = ++this.revision;
    this.generation = null;
    this.earlyDisconnects.clear();
    this.update({ pending: true });
    try {
      const unlisten = await this.bridge.subscribe((event) => this.receive(event));
      if (!this.owns(revision)) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
      const reply = await this.bridge.invoke('inspect_fixture');
      this.establish(reply, 'Bundled backend connected', revision);
    } catch (error) {
      if (this.owns(revision)) this.update({ connection: 'disconnected', detail: String(error) });
    } finally {
      if (this.owns(revision)) this.update({ pending: false });
    }
  }
  private receive(event: HostEvent) {
    if (this.disposed) return;
    if (this.generation === null && this.state.connection === 'connecting') {
      if (event.event === 'disconnected' && this.earlyDisconnects.size < 16)
        this.earlyDisconnects.set(event.generation, event);
      return;
    }
    if (event.generation !== this.generation) return;
    if (event.event === 'disconnected') {
      this.revision++;
      this.starting = false;
      this.early.clear();
      this.update({ connection: 'disconnected', pending: false, detail: event.detail });
      return;
    }
    if (this.state.connection !== 'connected') return;
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
    const revision = this.revision;
    try {
      const reply = await this.bridge!.invoke('inspect_fixture');
      if (
        this.owns(revision) &&
        reply.generation === this.generation &&
        this.state.connection === 'connected'
      )
        this.update({ fixture: decodeFixture(reply.data) });
    } catch (error) {
      if (this.owns(revision)) this.update({ detail: String(error) });
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
    const revision = ++this.revision;
    this.starting = true;
    this.early.clear();
    this.update({ pending: true, operation: null, detail: 'Starting fixture operation' });
    try {
      const reply = await this.bridge.invoke('start_fixture');
      if (
        !this.owns(revision) ||
        reply.generation !== this.generation ||
        this.state.connection !== 'connected'
      )
        return;
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
      if (this.owns(revision)) this.update({ detail: String(error) });
    } finally {
      if (this.owns(revision)) {
        this.starting = false;
        this.update({ pending: false });
      }
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
    const revision = ++this.revision;
    this.update({ pending: true });
    try {
      await this.bridge.invoke(command);
    } catch (error) {
      if (this.owns(revision)) this.update({ detail: String(error) });
    } finally {
      if (this.owns(revision)) this.update({ pending: false });
    }
  }
  async restart() {
    if (!this.bridge || this.state.pending) return;
    const revision = ++this.revision;
    this.generation = null;
    this.starting = false;
    this.early.clear();
    this.earlyDisconnects.clear();
    this.update({
      pending: true,
      connection: 'connecting',
      operation: null,
      detail: 'Starting a fresh backend',
    });
    try {
      const reply = await this.bridge.invoke('restart_backend');
      this.establish(reply, 'Fresh backend connected. Fixture reset.', revision);
    } catch (error) {
      if (this.owns(revision)) this.update({ connection: 'disconnected', detail: String(error) });
    } finally {
      if (this.owns(revision)) this.update({ pending: false });
    }
  }
  dispose() {
    this.disposed = true;
    this.revision++;
    this.earlyDisconnects.clear();
    this.unlisten?.();
    this.listeners.clear();
  }
}
