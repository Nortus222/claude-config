import {
  decodeApplyResult, decodeInspectResult, decodePreviewResult,
  type InspectResult, type PreviewResult, type RunEvent, type RunProgress,
} from '../backend/protocol.ts';
import type { Bridge, Envelope, HostEvent } from './bridge.ts';

export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'cancelled';
export type StepView = { readonly key: string; readonly summary: string; readonly status: StepStatus; readonly note: string };
export type RunView = {
  readonly runId: string;
  readonly steps: ReadonlyArray<StepView>;
  readonly outcome: 'running' | 'done' | 'cancelled' | 'failed';
  readonly summary: string;
  readonly backups?: string;
};
export type ViewState = {
  readonly connection: 'connecting' | 'connected' | 'disconnected' | 'browser';
  readonly inspection: InspectResult | null;
  readonly excluded: ReadonlyArray<string>;
  readonly preview: PreviewResult | null;
  readonly run: RunView | null;
  readonly pending: boolean;
  readonly detail: string;
};

const MAX_EARLY_EVENTS = 10_000;
const STALE = 'The machine changed since this preview. Review the updated plan, then apply again.';
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const backups = (path: string | undefined) => (path ? { backups: path } : {});

// Folds one progress event into a run's view.
export function advance(run: RunView, progress: RunProgress): RunView {
  const mark = (index: number, status: StepStatus, note = '') =>
    run.steps.map((s, i) => (i === index ? { ...s, status, note } : s));
  switch (progress.type) {
    case 'started':
      return { ...run, steps: mark(progress.index, 'running'), summary: progress.step.summary };
    case 'finished':
      return { ...run, steps: mark(progress.index, progress.outcome, progress.note) };
    case 'done':
      return { ...run, outcome: 'done', summary: `${progress.ok} applied, ${progress.failed} failed`, ...backups(progress.backups) };
    case 'cancelled':
      return { ...run, outcome: 'cancelled', summary: `Cancelled; ${progress.remaining.length} not started`, ...backups(progress.backups) };
    case 'failed':
      return { ...run, outcome: 'failed', summary: progress.message };
  }
}

// Drives the narrow bridge: ignores events from old backends, old runs and superseded replies.
export class MachineController {
  state: ViewState = {
    connection: 'connecting', inspection: null, excluded: [], preview: null, run: null, pending: false,
    detail: 'Connecting to the bundled backend',
  };
  private bridge: Bridge | null;
  private generation: number | null = null;
  private disposed = false;
  private unlisten?: () => void;
  private listeners = new Set<() => void>();
  private revision = 0;
  private starting = false;
  private early: RunEvent[] = [];
  private earlyDisconnects = new Map<number, Extract<HostEvent, { event: 'disconnected' }>>();

  constructor(bridge: Bridge | null) {
    this.bridge = bridge;
    if (!bridge) this.state = { ...this.state, connection: 'browser', detail: 'Browser preview. Open the desktop app to inspect this machine.' };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = () => this.state;

  private update(update: Partial<ViewState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  private owns(revision: number) {
    return !this.disposed && this.revision === revision;
  }
  private current(revision: number, reply: Envelope) {
    return this.owns(revision) && reply.generation === this.generation && this.state.connection === 'connected';
  }
  private ready() {
    return this.bridge !== null && this.state.connection === 'connected' && !this.state.pending && this.state.run?.outcome !== 'running';
  }

  // Adopts a backend generation; a disconnect for it that arrived first wins.
  private establish(reply: Envelope, detail: string, revision: number) {
    if (!this.owns(revision)) return false;
    this.generation = reply.generation;
    const disconnected = this.earlyDisconnects.get(reply.generation);
    this.earlyDisconnects.clear();
    if (disconnected) {
      this.revision++;
      this.update({ connection: 'disconnected', pending: false, detail: disconnected.detail });
      return false;
    }
    this.update({ connection: 'connected', detail });
    return true;
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
      if (!this.establish(await this.bridge.invoke('backend_generation'), 'Bundled backend connected', revision)) return;
      await this.load(revision);
    } catch (error) {
      if (this.owns(revision)) this.update({ connection: 'disconnected', detail: message(error) });
    } finally {
      if (this.owns(revision)) this.update({ pending: false });
    }
  }

  // Inspects within an action that already holds `pending`; a refusal leaves the app connected.
  private async load(revision: number) {
    this.update({ detail: 'Inspecting this machine' });
    try {
      const reply = await this.bridge!.invoke('inspect_machine');
      if (!this.current(revision, reply)) return;
      const inspection = decodeInspectResult(reply.data);
      const keys = new Set(inspection.items.map((item) => item.key));
      this.update({
        inspection, preview: null, excluded: this.state.excluded.filter((key) => keys.has(key)),
        detail: `Inspected ${inspection.items.length} items`,
      });
    } catch (error) {
      if (this.owns(revision)) this.update({ inspection: null, preview: null, detail: message(error) });
    }
  }

  async inspect() {
    if (!this.ready()) return;
    const revision = ++this.revision;
    this.update({ pending: true });
    try {
      await this.load(revision);
    } finally {
      if (this.owns(revision)) this.update({ pending: false });
    }
  }

  toggle(key: string) {
    if (!this.ready()) return;
    const excluded = this.state.excluded.includes(key) ? this.state.excluded.filter((k) => k !== key) : [...this.state.excluded, key];
    this.update({ excluded, preview: null });
  }

  async previewPlan() {
    if (!this.ready() || !this.state.inspection) return;
    const revision = ++this.revision;
    this.update({ pending: true, detail: 'Planning' });
    try {
      const reply = await this.bridge!.invoke('preview_plan', { exclude: [...this.state.excluded] });
      if (!this.current(revision, reply)) return;
      const preview = decodePreviewResult(reply.data);
      this.update({ preview, detail: `${preview.plan.steps.length} steps, ${preview.plan.skipped.length} skipped` });
    } catch (error) {
      if (this.owns(revision)) this.update({ detail: message(error) });
    } finally {
      if (this.owns(revision)) this.update({ pending: false });
    }
  }

  async apply() {
    const preview = this.state.preview;
    if (!this.ready() || !preview) return;
    const revision = ++this.revision;
    this.starting = true;
    this.early = [];
    this.update({ pending: true, detail: 'Re-inspecting before applying' });
    let finished = false;
    try {
      const reply = await this.bridge!.invoke('apply_plan', { planId: preview.planId });
      if (!this.current(revision, reply)) return;
      const result = decodeApplyResult(reply.data);
      if (result.status === 'stale') {
        this.update({ preview: { planId: result.planId, plan: result.plan }, detail: STALE });
        return;
      }
      const buffered = this.early.filter((event) => event.runId === result.runId);
      this.starting = false;
      this.early = [];
      const initial: RunView = {
        runId: result.runId, outcome: 'running', summary: 'Starting',
        steps: preview.plan.steps.map((step) => ({ key: step.key, summary: step.summary, status: 'pending', note: '' })),
      };
      const run = buffered.reduce((view, event) => (view.outcome === 'running' ? advance(view, event.progress) : view), initial);
      finished = run.outcome !== 'running';
      this.update({ run, detail: run.summary, ...(finished ? { preview: null } : {}) });
    } catch (error) {
      if (this.owns(revision)) this.update({ detail: message(error) });
    } finally {
      if (this.owns(revision)) {
        this.starting = false;
        this.early = [];
        this.update({ pending: false });
      }
    }
    // The run ended before this request returned: its terminal event was buffered, so look again here.
    if (finished && this.owns(revision)) await this.inspect();
  }

  async cancel() {
    if (!this.bridge || this.state.connection !== 'connected' || this.state.run?.outcome !== 'running') return;
    try {
      await this.bridge.invoke('cancel_apply');
    } catch (error) {
      if (!this.disposed) this.update({ detail: message(error) });
    }
  }

  async restart() {
    if (!this.bridge || this.state.pending || this.state.run?.outcome === 'running') return;
    const revision = ++this.revision;
    this.generation = null;
    this.starting = false;
    this.early = [];
    this.earlyDisconnects.clear();
    this.update({ pending: true, connection: 'connecting', run: null, preview: null, detail: 'Starting a fresh backend' });
    try {
      if (!this.establish(await this.bridge.invoke('restart_backend'), 'Fresh backend connected', revision)) return;
      await this.load(revision);
    } catch (error) {
      if (this.owns(revision)) this.update({ connection: 'disconnected', detail: message(error) });
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

  private receive(event: HostEvent) {
    if (this.disposed) return;
    if (this.generation === null) {
      if (event.event === 'disconnected' && this.earlyDisconnects.size < 16) this.earlyDisconnects.set(event.generation, event);
      return;
    }
    if (event.generation !== this.generation) return;
    if (event.event === 'disconnected') {
      this.revision++;
      this.starting = false;
      this.early = [];
      const run = this.state.run?.outcome === 'running'
        ? { ...this.state.run, outcome: 'failed' as const, summary: 'Backend disconnected during the run' }
        : this.state.run;
      this.update({ connection: 'disconnected', pending: false, detail: event.detail, run });
      return;
    }
    if (this.state.connection !== 'connected') return;
    if (this.starting) {
      if (this.early.length < MAX_EARLY_EVENTS) this.early.push(event);
      return;
    }
    const run = this.state.run;
    if (!run || run.runId !== event.runId || run.outcome !== 'running') return;
    const next = advance(run, event.progress);
    if (next.outcome === 'running') {
      this.update({ run: next, detail: next.summary });
      return;
    }
    // The preview is spent and the machine has changed: look again.
    this.update({ run: next, detail: next.summary, preview: null });
    void this.inspect();
  }
}
