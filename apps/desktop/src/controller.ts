import {
  decodeApplyResult, decodeInspectResult, decodePreviewResult, decodeHelloResult, decodeWireStatus,
  type HelloResult, type InspectResult, type PreviewResult, type RunEvent, type RunProgress, type WireStatus,
} from '@nortuscc/agent/ipc/protocol';
import type { Bridge, Envelope, HostEvent } from './bridge.ts';

export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'cancelled';
export type StepView = { readonly key: string; readonly summary: string; readonly status: StepStatus; readonly note: string; readonly index?: number };
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
  readonly initialReadPending: boolean;
  readonly waitingForReport: boolean;
  readonly initialReadError: string | null;
  readonly detail: string;
  readonly reviewRequested: number;
  readonly session: number;
};

// The agent can own a manual run that began before this window connected.
export const canCancel = (state: ViewState) => state.connection === 'connected'
  && (state.run?.outcome === 'running' || state.status?.applying === true);

const MAX_EARLY_EVENTS = 10_000;
const STALE = 'The machine changed since this preview. Review the updated plan, then apply again.';
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const backups = (path: string | undefined) => (path ? { backups: path } : {});
const checkedReply = <T>(decode: (value: unknown) => T, value: unknown): T => {
  try { return decode(value); }
  catch { throw new Error('MALFORMED: incompatible agent response. Restart or reinstall the agent explicitly.'); }
};

// Folds one progress event into a run's view.
export function advance(run: RunView, progress: RunProgress): RunView {
  const mark = (index: number, status: StepStatus, note = '') =>
    run.steps.map((s, i) => ((s.index ?? i) === index ? { ...s, status, note } : s));
  switch (progress.type) {
    case 'started': {
      const current = run.steps.findIndex((step, index) => (step.index ?? index) === progress.index);
      const started: StepView = { key: progress.step.key, summary: progress.step.summary, status: 'running', note: '' };
      const steps = current < 0
        ? [...run.steps, { ...started, index: progress.index }]
        : run.steps.map((step, index) => index === current ? { ...step, ...started } : step);
      return { ...run, steps, summary: progress.step.summary };
    }
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
    initialReadPending: true, waitingForReport: false, initialReadError: null,
    detail: 'Connecting to the local agent', reviewRequested: 0, session: 0,
  };
  private bridge: Bridge | null;
  private generation: number | null = null;
  private disposed = false;
  private unlisten?: () => void;
  private listeners = new Set<() => void>();
  private revision = 0;
  private starting = false;
  private early: RunEvent[] = [];
  private reviewRefresh = false;
  private earlyReviews = new Set<number>();
  private earlyStatuses = new Map<number, WireStatus>();
  private earlyDisconnects = new Map<number, Extract<HostEvent, { event: 'disconnected' }>>();
  private statusRevision = 0;

  constructor(bridge: Bridge | null) {
    this.bridge = bridge;
    if (!bridge) this.state = { ...this.state, connection: 'browser', initialReadPending: false, detail: 'Browser preview. Open the desktop app to inspect this machine.' };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = () => this.state;

  sessionToken = () => ({ session: this.state.session, generation: this.generation });
  ownsSession = (token: ReturnType<MachineController['sessionToken']>, reply?: Envelope) =>
    !this.disposed && this.state.connection === 'connected' && token.session === this.state.session
    && token.generation === this.generation && (!reply || reply.generation === this.generation);
  acceptStatus(token: ReturnType<MachineController['sessionToken']>, reply: Envelope) {
    if (!this.ownsSession(token, reply)) return false;
    this.showStatus(decodeWireStatus(reply.data));
    return true;
  }

  private update(update: Partial<ViewState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
    if (update.pending === false) this.refreshReview();
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

  private requestReview() {
    this.reviewRefresh = true;
    this.update({ reviewRequested: this.state.reviewRequested + 1 });
    this.refreshReview();
  }

  private refreshReview() {
    if (!this.reviewRefresh || !this.ready()) return;
    this.reviewRefresh = false;
    void this.inspect();
  }

  private async takeReviewRequest(revision: number) {
    try {
      const reply = await this.bridge!.invoke('take_review_request');
      if (this.current(revision, reply) && typeof reply.data === 'object' && reply.data !== null
        && 'requested' in reply.data && reply.data.requested === true) this.requestReview();
    } catch {
      // Routing is optional; it cannot change the agent connection's health.
    }
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
      this.update({ connection: 'disconnected', pending: false, initialReadPending: false, waitingForReport: false, initialReadError: disconnected.detail, detail: disconnected.detail });
      return false;
    }
    let hello: HelloResult | null = null;
    if (typeof reply.data === 'object' && reply.data !== null && 'hello' in reply.data) {
      try { hello = decodeHelloResult(reply.data.hello); }
      catch { throw new Error('Incompatible agent protocol. Restart or reinstall the agent explicitly.'); }
    }
    this.update({ connection: 'connected', detail, hello, status });
    if (status) this.showStatus(status);
    const review = this.earlyReviews.has(reply.generation);
    this.earlyReviews.clear();
    if (review) this.requestReview();
    return true;
  }

  async connect() {
    if (!this.bridge) return;
    const revision = ++this.revision;
    this.generation = null;
    this.reviewRefresh = false;
    this.earlyReviews.clear();
    this.earlyDisconnects.clear();
    this.earlyStatuses.clear();
    this.unlisten?.();
    this.update({ pending: true, initialReadPending: true, waitingForReport: false, initialReadError: null, connection: 'connecting',
      session: this.state.session + 1, inspection: null, status: null, hello: null, preview: null, run: null, detail: 'Connecting to the local agent' });
    try {
      const unlisten = await this.bridge.subscribe((event) => this.receive(event));
      if (!this.owns(revision)) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
      if (!this.establish(await this.bridge.invoke('agent_generation'), 'Agent connected', revision)) return;
      await this.takeReviewRequest(revision);
      if (await this.loadStatus(revision, true)) await this.load(revision);
    } catch (error) {
      if (this.owns(revision)) this.update({ connection: 'disconnected', waitingForReport: false, initialReadError: message(error), detail: message(error) });
    } finally {
      if (this.owns(revision)) this.update({ pending: false, initialReadPending: false });
    }
  }

  private showStatus(status: WireStatus) {
    const detail = status.error ? `${status.error}${status.detail ? `: ${status.detail}` : ''}`
      : status.applying ? 'The agent is applying changes'
      : status.paused ? `Automatic apply paused: ${status.paused.reason}` : undefined;
    this.statusRevision++;
    this.update({ status, waitingForReport: false,
      ...(status.applying || status.error ? { initialReadPending: false }
        : this.state.waitingForReport && !this.state.inspection ? { initialReadPending: true } : {}),
      ...(detail && this.state.run?.outcome !== 'running' ? { detail } : {}) });
  }

  private refused(error: unknown, update: Partial<ViewState> = {}) {
    const detail = message(error);
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : detail;
    const offline = /UNAUTHORIZED|MALFORMED|OVERSIZED|CLOSED|disconnected|closed the connection|incompatible|protocol/i.test(code);
    this.update({ ...update, initialReadPending: false, waitingForReport: false,
      ...(this.state.initialReadPending || this.state.waitingForReport ? { initialReadError: detail } : {}),
      detail, ...(offline ? { connection: 'disconnected' } : {}) });
  }

  private async loadStatus(revision: number, initialConnection = false): Promise<boolean> {
    const statusRevision = this.statusRevision;
    try {
      const reply = await this.bridge!.invoke('agent_status');
      if (!this.current(revision, reply)) return false;
      let status: WireStatus;
      try { status = decodeWireStatus(reply.data); }
      catch { throw new Error('MALFORMED: incompatible agent status. Restart or reinstall the agent explicitly.'); }
      if (this.statusRevision !== statusRevision && this.state.status) {
        return !this.state.status.applying && (!initialConnection || !this.state.status.error);
      }
      this.showStatus(status);
      return !status.applying && (!initialConnection || !status.error);
    } catch (error) {
      if (!this.owns(revision)) return false;
      const noReport = typeof error === 'object' && error !== null && 'code' in error
        ? error.code === 'NO_REPORT' : /^NO_REPORT\b/.test(message(error));
      if (noReport && this.state.connection === 'connected') {
        if (this.state.status !== null && (initialConnection || this.state.initialReadPending && this.state.inspection === null || this.statusRevision !== statusRevision)) {
          return !this.state.status.applying && (!initialConnection || !this.state.status.error);
        }
        if (this.state.status === null && this.state.initialReadPending && this.state.inspection === null) {
          this.update({ waitingForReport: true, detail: 'Waiting for the agent’s first inspection.' });
          return false;
        }
      }
      this.refused(error);
      return false;
    }
  }

  // Inspects within an action that already holds `pending`; a refusal leaves the app connected.
  private async load(revision: number) {
    this.reviewRefresh = false;
    this.update({ detail: 'Inspecting this machine' });
    const statusRevision = this.statusRevision;
    const initialRead = this.state.initialReadPending;
    try {
      const reply = await this.bridge!.invoke('inspect_machine');
      if (!this.current(revision, reply)) return;
      const inspection = checkedReply(decodeInspectResult, reply.data);
      const status = this.statusRevision !== statusRevision ? this.state.status : inspection.status ?? this.state.status;
      const keys = new Set(inspection.items.map((item) => item.key));
      this.update({
        inspection, status, initialReadError: null, preview: null, excluded: this.state.excluded.filter((key) => keys.has(key)),
        detail: status?.error ? `${status.error}: ${status.detail ?? ''}` : `Inspected ${inspection.items.length} items`,
      });
    } catch (error) {
      if (this.owns(revision)) this.refused(error, { inspection: null, preview: null, ...(initialRead ? { initialReadError: message(error) } : {}) });
    }
  }

  async inspect() {
    if (!this.bridge || this.state.connection !== 'connected' || this.state.pending || this.state.run?.outcome === 'running') return;
    const revision = ++this.revision;
    this.update({ pending: true, ...(this.state.waitingForReport || this.state.initialReadError ? { initialReadPending: true, initialReadError: null } : {}) });
    try {
      if (await this.loadStatus(revision)) await this.load(revision);
    } finally {
      if (this.owns(revision)) this.update({ pending: false, initialReadPending: false });
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
      const preview = checkedReply(decodePreviewResult, reply.data);
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
      const result = checkedReply(decodeApplyResult, reply.data);
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
    this.reviewRefresh = false;
    this.earlyReviews.clear();
    this.starting = false;
    this.early = [];
    this.earlyDisconnects.clear();
    this.earlyStatuses.clear();
    this.update({ pending: true, initialReadPending: true, waitingForReport: false, initialReadError: null, connection: 'connecting', session: this.state.session + 1, run: null, preview: null, inspection: null, status: null, hello: null, detail: 'Restarting the local agent' });
    try {
      if (!this.establish(await this.bridge.invoke('restart_agent'), 'Agent connected', revision)) return;
      await this.takeReviewRequest(revision);
      if (await this.loadStatus(revision, true)) await this.load(revision);
    } catch (error) {
      if (this.owns(revision)) this.update({ connection: 'disconnected', waitingForReport: false, initialReadError: message(error), detail: message(error) });
    } finally {
      if (this.owns(revision)) this.update({ pending: false, initialReadPending: false });
    }
  }

  dispose() {
    this.update({ connection: 'disconnected', session: this.state.session + 1, pending: false, initialReadPending: false, waitingForReport: false });
    this.disposed = true;
    this.earlyReviews.clear();
    this.reviewRefresh = false;
    this.revision++;
    this.earlyDisconnects.clear();
    this.earlyStatuses.clear();
    this.unlisten?.();
    this.listeners.clear();
  }

  private receive(event: HostEvent) {
    if (this.disposed) return;
    if (this.generation === null) {
      if (event.event === 'review-requested' && this.earlyReviews.size < 16) this.earlyReviews.add(event.generation);
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
      this.update({ connection: 'disconnected', session: this.state.session + 1, pending: false, initialReadPending: false, waitingForReport: false,
        ...(this.state.initialReadPending || this.state.waitingForReport ? { initialReadError: event.detail } : {}), detail: event.detail, run });
      return;
    }
    if (this.state.connection !== 'connected') return;
    if (event.event === 'review-requested') {
      // The event routes immediately; consuming its native flag prevents replay on reconnect.
      void this.bridge!.invoke('take_review_request').catch(() => {});
      this.requestReview();
      return;
    }
    if (event.event === 'status') {
      const externalApplyEnded = this.state.status?.applying === true && this.state.run?.outcome !== 'running' && event.status.applying === false;
      this.showStatus(event.status);
      this.refreshReview();
      if ((!this.state.inspection || externalApplyEnded) && !event.status.applying && !this.state.pending) void this.inspect();
      return;
    }
    if (this.starting) {
      if (this.early.length < MAX_EARLY_EVENTS) this.early.push(event);
      return;
    }
    let run = this.state.run;
    if (event.progress.type === 'started' && run?.outcome !== 'running') {
      run = { runId: event.runId, steps: [], outcome: 'running', summary: 'Applying machine changes' };
      this.update({ preview: null, status: this.state.status ? { ...this.state.status, applying: true } : null });
    }
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
