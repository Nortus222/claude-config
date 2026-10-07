import {
  decodeApplyResult, decodeInspectResult, decodePreviewResult, decodeHelloResult, decodeWireStatus,
  type HelloResult, type InspectResult, type PreviewResult, type RunEvent, type RunProgress, type WireStatus,
} from '@nortuscc/agent/ipc/protocol';
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
  readonly status: WireStatus | null;
  readonly hello: HelloResult | null;
  readonly excluded: ReadonlyArray<string>;
  readonly preview: PreviewResult | null;
  readonly run: RunView | null;
  readonly pending: boolean;
  readonly detail: string;
};

// The agent can own a manual run that began before this window connected.
export const canCancel = (state: ViewState) => state.connection === 'connected'
  && (state.run?.outcome === 'running' || state.status?.applying === true);

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

// Drives the narrow bridge: ignores events from old agent connections, old runs and superseded replies.
export class MachineController {
  state: ViewState = {
    connection: 'connecting', inspection: null, status: null, hello: null, excluded: [], preview: null, run: null, pending: false,
    detail: 'Connecting to the local agent',
  };
  private bridge: Bridge | null;
  private generation: number | null = null;
  private disposed = false;
  private unlisten?: () => void;
  private listeners = new Set<() => void>();
  private revision = 0;
  private starting = false;
  private early: RunEvent[] = [];
  private earlyStatuses = new Map<number, WireStatus>();
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
    return this.bridge !== null && this.state.connection === 'connected' && !this.state.pending && this.state.run?.outcome !== 'running' && this.state.status?.applying !== true;
  }

  // Adopts an agent connection generation; a disconnect for it that arrived first wins.
  private establish(reply: Envelope, detail: string, revision: number) {
    if (!this.owns(revision)) return false;
    this.generation = reply.generation;
    const status = this.earlyStatuses.get(reply.generation) ?? null;
    this.earlyStatuses.clear();
    const disconnected = this.earlyDisconnects.get(reply.generation);
    this.earlyDisconnects.clear();
    if (disconnected) {
      this.revision++;
      this.update({ connection: 'disconnected', pending: false, detail: disconnected.detail });
      return false;
    }
    let hello: HelloResult | null = null;
    if (typeof reply.data === 'object' && reply.data !== null && 'hello' in reply.data) {
      try { hello = decodeHelloResult(reply.data.hello); }
      catch { throw new Error('Incompatible agent protocol. Restart or reinstall the agent explicitly.'); }
    }
    this.update({ connection: 'connected', detail, hello, status });
    return true;
  }

  async connect() {
    if (!this.bridge) return;
    const revision = ++this.revision;
    this.generation = null;
    this.earlyDisconnects.clear();
    this.earlyStatuses.clear();
    this.update({ pending: true });
    try {
      const unlisten = await this.bridge.subscribe((event) => this.receive(event));
      if (!this.owns(revision)) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
      if (!this.establish(await this.bridge.invoke('agent_generation'), 'Agent connected', revision)) return;
      if (await this.loadStatus(revision)) await this.load(revision);
    } catch (error) {
      if (this.owns(revision)) this.update({ connection: 'disconnected', detail: message(error) });
    } finally {
      if (this.owns(revision)) this.update({ pending: false });
    }
  }

  private showStatus(status: WireStatus) {
    const detail = status.error ? `${status.error}${status.detail ? `: ${status.detail}` : ''}`
      : status.applying ? 'The agent is applying changes'
      : status.paused ? `Automatic apply paused: ${status.paused.reason}` : undefined;
    this.update({ status, ...(detail && this.state.run?.outcome !== 'running' ? { detail } : {}) });
  }

  private refused(error: unknown, update: Partial<ViewState> = {}) {
    const detail = message(error);
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : detail;
    const offline = /UNAUTHORIZED|MALFORMED|OVERSIZED|CLOSED|disconnected|closed the connection|incompatible|protocol/i.test(code);
    this.update({ ...update, detail, ...(offline ? { connection: 'disconnected' } : {}) });
  }

  private async loadStatus(revision: number): Promise<boolean> {
    try {
      const reply = await this.bridge!.invoke('agent_status');
      if (!this.current(revision, reply)) return false;
      let status: WireStatus;
      try { status = decodeWireStatus(reply.data); }
      catch { throw new Error('MALFORMED: incompatible agent status. Restart or reinstall the agent explicitly.'); }
      this.showStatus(status);
      return !status.applying;
    } catch (error) {
      if (!this.owns(revision)) return false;
      this.refused(error);
      const noReport = typeof error === 'object' && error !== null && 'code' in error
        ? error.code === 'NO_REPORT' : /^NO_REPORT\b/.test(message(error));
      return noReport && this.state.inspection === null && this.state.connection === 'connected'
        && this.state.status !== null && !this.state.status.applying;
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
        inspection, status: inspection.status ?? this.state.status, preview: null, excluded: this.state.excluded.filter((key) => keys.has(key)),
        detail: inspection.status?.error ? `${inspection.status.error}: ${inspection.status.detail ?? ''}` : `Inspected ${inspection.items.length} items`,
      });
    } catch (error) {
      if (this.owns(revision)) this.refused(error, { inspection: null, preview: null });
    }
  }

  async inspect() {
    if (!this.bridge || this.state.connection !== 'connected' || this.state.pending || this.state.run?.outcome === 'running') return;
    const revision = ++this.revision;
    this.update({ pending: true });
    try {
      if (await this.loadStatus(revision)) await this.load(revision);
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
      if (this.owns(revision)) this.refused(error);
    } finally {
      if (this.owns(revision)) this.update({ pending: false });
    }
  }

  // Refreshes activity after preparation ends without discarding the preview.
  private async settlePreparation(revision: number, detail: string) {
    if (await this.loadStatus(revision) && this.owns(revision) && !this.state.status?.error) this.update({ detail });
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
        await this.settlePreparation(revision, STALE);
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
      this.update({ run, detail: run.summary, ...(finished ? { preview: null, status: this.state.status ? { ...this.state.status, applying: false } : null } : {}) });
    } catch (error) {
      if (this.owns(revision)) {
        this.refused(error);
        if (this.state.connection === 'connected') await this.settlePreparation(revision, message(error));
      }
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

  // Asks the agent to stop the run; a failure is shown unless a disconnect or restart superseded it.
  async cancel() {
    if (!this.bridge || !canCancel(this.state)) return;
    const revision = this.revision;
    try {
      const reply = await this.bridge.invoke('cancel_apply');
      if (!this.current(revision, reply)) return;
      if (this.state.run?.outcome !== 'running') {
        const cancelled = typeof reply.data === 'object' && reply.data !== null && 'cancelled' in reply.data
          && reply.data.cancelled === true;
        this.update({ detail: cancelled ? 'Cancellation requested; waiting for the agent' : 'No manual apply is available to cancel' });
      }
    } catch (error) {
      if (this.owns(revision)) this.refused(error);
    }
  }

  async restart() {
    if (!this.bridge || this.state.pending || (this.state.connection === 'connected' && (this.state.run?.outcome === 'running' || this.state.status?.applying === true))) return;
    const revision = ++this.revision;
    this.generation = null;
    this.starting = false;
    this.early = [];
    this.earlyDisconnects.clear();
    this.earlyStatuses.clear();
    this.update({ pending: true, connection: 'connecting', run: null, preview: null, inspection: null, status: null, hello: null, detail: 'Restarting the local agent' });
    try {
      if (!this.establish(await this.bridge.invoke('restart_agent'), 'Agent connected', revision)) return;
      if (await this.loadStatus(revision)) await this.load(revision);
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
    this.earlyStatuses.clear();
    this.unlisten?.();
    this.listeners.clear();
  }

  private receive(event: HostEvent) {
    if (this.disposed) return;
    if (this.generation === null) {
      if (event.event === 'disconnected' && this.earlyDisconnects.size < 16) this.earlyDisconnects.set(event.generation, event);
      if (event.event === 'status' && this.earlyStatuses.size < 16) this.earlyStatuses.set(event.generation, event.status);
      return;
    }
    if (event.generation !== this.generation) return;
    if (event.event === 'disconnected') {
      this.revision++;
      this.starting = false;
      this.early = [];
      const run = this.state.run?.outcome === 'running'
        ? { ...this.state.run, outcome: 'failed' as const, summary: 'Agent disconnected during the run' }
        : this.state.run;
      this.update({ connection: 'disconnected', pending: false, detail: event.detail, run });
      return;
    }
    if (this.state.connection !== 'connected') return;
    if (event.event === 'status') {
      const externalApplyEnded = this.state.status?.applying === true && this.state.run?.outcome !== 'running' && event.status.applying === false;
      this.showStatus(event.status);
      if ((!this.state.inspection || externalApplyEnded) && !event.status.applying && !this.state.pending) void this.inspect();
      return;
    }
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
    this.update({ run: next, detail: next.summary, preview: null, status: this.state.status ? { ...this.state.status, applying: false } : null });
    void this.inspect();
  }
}
