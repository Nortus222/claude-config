import {
  decodeInspectResult, decodeHelloResult, decodeWireStatus,
  type HelloResult, type InspectResult, type RunProgress, type WireStatus,
} from '@nortuscc/agent/ipc/protocol';
import { decodeRunView, decodeOperationOutput, type RunView as OperationRunView } from '@nortuscc/agent/operations';
import type { Bridge, Envelope, HostEvent } from './bridge.ts';

export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'cancelled';
export type StepView = { readonly key: string; readonly summary: string; readonly status: StepStatus; readonly note: string; readonly index?: number };
export type RunView = {
  readonly runId: string;
  readonly receipt?: OperationRunView;
  readonly challengeCurrent?: boolean;
  readonly steps: ReadonlyArray<StepView>;
  readonly outcome: 'running' | 'done' | 'cancelled' | 'failed' | 'interrupted' | 'abandoned';
  readonly summary: string;
  // Steps the agent reported as failed when the run finished.
  readonly failed?: number;
  readonly backups?: string;
  // Planned steps, as the run's progress reports them.
  readonly total?: number;
};
// What this Mac is busy with: a run in progress, or an apply the agent reports without a run this app
// follows (an automatic apply, or one from the CLI). Every page that changes this Mac waits while it is set.
export type MachineBusy = {
  // The run's change kind ('reconcile', 'setupApply', 'followProfile', 'update', 'addSkill', ...); null when unknown.
  readonly kind: string | null;
  readonly description: string;
  // Finished and planned steps, when known.
  readonly done: number | null;
  readonly total: number | null;
  // The step in flight, when known.
  readonly step: string | null;
  readonly runId: string | null;
};
export type ViewState = {
  readonly connection: 'connecting' | 'connected' | 'disconnected' | 'browser';
  readonly inspection: InspectResult | null;
  readonly status: WireStatus | null;
  readonly hello: HelloResult | null;
  readonly run: RunView | null;
  readonly pending: boolean;
  readonly initialReadPending: boolean;
  readonly waitingForReport: boolean;
  readonly initialReadError: string | null;
  readonly detail: string;
  readonly reviewRequested: number;
  readonly session: number;
  // Derived from `run` and `status`.
  readonly busy: MachineBusy | null;
};

// Terminal events remembered while a run discovery read is in flight.
const MAX_TRACKED_TERMINALS = 10_000;
// The author pages own drafts, gh sign-in and publication runs; they never become this machine's run.
export const AUTHOR_RUN_KINDS: ReadonlySet<string> = new Set(['editDraft', 'removeDraftIntent', 'deleteDraft', 'ghLogin', 'publishDraft', 'announcePublication']);
const machineRun = (run: OperationRunView) => !AUTHOR_RUN_KINDS.has(run.intent.change.kind);
// Discovery reads a page of the newest runs and adopts the newest machine run among them.
const DISCOVERY_PAGE = 50;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const backups = (path: string | undefined) => (path ? { backups: path } : {});
const checkedReply = <T>(decode: (value: unknown) => T, value: unknown): T => {
  try { return decode(value); }
  catch { throw new Error('MALFORMED: incompatible agent response. Restart or reinstall the agent explicitly.'); }
};

const BUSY: Readonly<Record<string, string>> = {
  reconcile: 'Applying changes on this Mac', setupApply: 'Applying incoming changes from your profile',
  followProfile: 'Switching the profile this Mac follows', update: 'Updating skills', addSkill: 'Adding a skill',
  machineIntent: 'Saving a choice for this Mac', uninstallConfig: 'Restoring configuration files', syncDecision: 'Saving a choice about an incoming change',
  setPolicy: 'Changing the apply policy', resume: 'Resuming automatic apply', signIn: 'Signing in', signOut: 'Signing out',
  syncAccount: 'Syncing your account', patchMachineMetadata: 'Updating this Mac\'s details', pruneBackups: 'Removing old backups',
};
const FINISHED: ReadonlySet<StepStatus> = new Set(['ok', 'failed', 'cancelled']);
// The run in progress, else an apply the agent reports.
export function machineBusy(state: Pick<ViewState, 'connection' | 'run' | 'status'>): MachineBusy | null {
  if (state.connection !== 'connected') return null;
  const run = state.run;
  if (run?.outcome === 'running') {
    const receipt = run.receipt, kind = receipt?.intent.change.kind ?? null;
    const planned = receipt?.intent.parity && 'plannedKeys' in receipt.intent.parity ? receipt.intent.parity.plannedKeys.length : undefined;
    const total = planned ?? run.total ?? null;
    const step = run.steps.find(step => step.status === 'running')?.summary ?? receipt?.current?.summary ?? null;
    return { kind, description: kind === null ? BUSY.reconcile! : BUSY[kind] ?? 'Working on this Mac', done: total === null ? null : run.steps.filter(step => FINISHED.has(step.status)).length,
      total, step, runId: run.runId };
  }
  return state.status?.applying ? { kind: null, description: 'The agent is applying changes on this Mac', done: null, total: null, step: null, runId: null } : null;
}

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
      return { ...run, steps, summary: progress.step.summary, total: progress.total };
    }
    case 'finished':
      return { ...run, steps: mark(progress.index, progress.outcome, progress.note), total: progress.total };
    case 'done':
      return { ...run, outcome: 'done', summary: `${progress.ok} applied, ${progress.failed} failed`, failed: progress.failed, ...backups(progress.backups) };
    case 'cancelled':
      return { ...run, outcome: 'cancelled', summary: `Cancelled; ${progress.remaining.length} not started`, ...backups(progress.backups) };
    case 'failed':
      return { ...run, outcome: 'failed', summary: progress.message };
  }
}

// Drives the narrow bridge: ignores events from old agent connections, old runs and superseded replies.
export class MachineController {
  state: ViewState = {
    connection: 'connecting', inspection: null, status: null, hello: null, run: null, pending: false,
    initialReadPending: true, waitingForReport: false, initialReadError: null,
    detail: 'Connecting to the local agent', reviewRequested: 0, session: 0, busy: null,
  };
  private bridge: Bridge | null;
  private generation: number | null = null;
  private disposed = false;
  private unlisten?: () => void;
  private listeners = new Set<() => void>();
  private revision = 0;
  private reviewRefresh = false;
  private earlyReviews = new Set<number>();
  private earlyStatuses = new Map<number, WireStatus>();
  private earlyDisconnects = new Map<number, Extract<HostEvent, { event: 'disconnected' }>>();
  private statusRevision = 0;
  private latestRunRead = 0;
  private discoveryPending = false;
  private discoveryFlight: { dirty: boolean; observed: boolean; promise?: Promise<void> } | null = null;
  private challengeTimer?: ReturnType<typeof setTimeout>;
  private runDiscovery: { readonly terminalRunIds: Set<string>; overflow: boolean } | null = null;

  constructor(bridge: Bridge | null) {
    this.bridge = bridge;
    if (!bridge) this.state = { ...this.state, connection: 'browser', initialReadPending: false, detail: 'Browser preview. Open the desktop app to see this Mac.' };
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
    if ('run' in update && this.state.run && update.run?.runId !== this.state.run.runId) this.latestRunRead++;
    this.state = { ...this.state, ...update };
    const busy = machineBusy(this.state);
    if (JSON.stringify(busy) !== JSON.stringify(this.state.busy)) this.state = { ...this.state, busy };
    if (this.state.connection !== 'connected') {
      this.discoveryFlight = null;
      this.discoveryPending = false;
      if (this.state.run) this.state = { ...this.state, run: { ...this.state.run, challengeCurrent: false } };
    }
    if ('run' in update || 'connection' in update) this.scheduleChallengeExpiry();
    for (const listener of this.listeners) listener();
    if (this.discoveryPending && this.state.run?.outcome !== 'running') void this.discoverRuns(true);
    if (update.pending === false) this.refreshReview();
  }

  // Unknown invalidations have no acceptance order. Coalesce them through the owner's latest-first list.
  private async discoverRuns(observed = false) {
    if (!this.bridge || this.state.connection !== 'connected' || this.state.hello?.operations?.available !== true) return;
    if (this.state.run?.outcome === 'running') { this.discoveryPending = true; return; }
    this.discoveryPending = false;
    if (this.discoveryFlight) { this.discoveryFlight.dirty = true; this.discoveryFlight.observed ||= observed; return this.discoveryFlight.promise; }
    const token = this.sessionToken();
    const flight = { dirty: false, observed, promise: undefined as Promise<void> | undefined };
    this.discoveryFlight = flight;
    flight.promise = (async () => {
      do {
        flight.dirty = false;
        await this.refreshRun(undefined, flight.observed);
      } while (flight.dirty && this.ownsSession(token) && this.state.run?.outcome !== 'running');
      if (flight.dirty && this.ownsSession(token)) this.discoveryPending = true;
    })().finally(() => { if (this.discoveryFlight === flight) this.discoveryFlight = null; });
    return flight.promise;
  }

  // A cached challenge is displayable only while its safe read and deadline remain current.
  private scheduleChallengeExpiry() {
    clearTimeout(this.challengeTimer);
    this.challengeTimer = undefined;
    const run = this.state.run;
    const signIn = run?.receipt?.parity?.kind === 'signIn' ? run.receipt.parity.signIn : undefined;
    if (this.state.connection !== 'connected' || !run || run.challengeCurrent === false || signIn?.state !== 'awaiting-user') return;
    const token = this.sessionToken();
    const remaining = Date.parse(signIn.expiresAt) - Date.now();
    if (remaining <= 0) {
      this.state = { ...this.state, run: { ...run, challengeCurrent: false } };
      return;
    }
    this.challengeTimer = setTimeout(() => {
      if (!this.ownsSession(token) || this.state.run !== run) return;
      this.update({ run: { ...run, challengeCurrent: Date.now() < Date.parse(signIn.expiresAt) } });
    }, Math.min(remaining, 2_147_483_647));
  }

  private concealChallenge() {
    const run = this.state.run;
    if (run?.receipt?.parity?.kind === 'signIn' && run.receipt.parity.signIn?.state === 'awaiting-user') {
      if (run.challengeCurrent !== false) this.update({ run: { ...run, challengeCurrent: false } });
      return run.runId;
    }
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

  // Durable reads share this controller's session and never replace a different active run.
  private async refreshRun(runId?: string, completionObserved = false) {
    if (!this.bridge || this.state.hello?.operations?.available !== true) return;
    const token = this.sessionToken();
    const statusRevision = this.statusRevision;
    const previousRunId = this.state.run?.runId;
    const targetedAtStart = this.latestRunRead;
    const targetedRead = runId ? ++this.latestRunRead : undefined;
    if (runId) {
      if (this.state.run?.runId === runId) this.concealChallenge();
    }
    const discovery = runId ? null : { terminalRunIds: new Set<string>(), overflow: false };
    if (discovery) this.runDiscovery = discovery;
    try {
      const reply = runId ? await this.bridge.invoke('get_operation_run', { runId })
        : await this.bridge.invoke('list_operation_runs', { limit: DISCOVERY_PAGE });
      if (!this.ownsSession(token, reply) || (runId ? targetedRead !== this.latestRunRead : this.runDiscovery !== discovery)) return;
      if (!runId && this.discoveryFlight?.dirty) return;
      if (discovery?.overflow) {
        if (this.state.run) return;
        const detail = 'Run activity exceeded the discovery limit. Reconnect to read current runs.';
        this.revision++;
        this.update({ connection: 'disconnected', pending: false, initialReadPending: false, waitingForReport: false, initialReadError: detail, detail });
        return;
      }
      const receipt = runId ? checkedReply(decodeRunView, reply.data)
        : checkedReply(value => decodeOperationOutput('listRuns', value), reply.data).runs.find(machineRun);
      if (!receipt || runId && receipt.runId !== runId || !machineRun(receipt)) return;
      const current = this.state.run;
      if (current && current.runId !== receipt.runId && current.outcome === 'running') return;
      if (!runId && current?.runId === receipt.runId && targetedAtStart !== this.latestRunRead) return;
      if (runId && current && current.runId !== receipt.runId && current.runId !== previousRunId) return;
      // A matching terminal event makes the discovery snapshot's state obsolete, even without a view.
      if (discovery?.terminalRunIds.has(receipt.runId)) {
        await this.refreshRun(receipt.runId, true);
        return;
      }
      if (!current && this.state.status?.applying && receipt.result !== null && !completionObserved) return;
      const outcome = receipt.state === 'accepted' || receipt.state === 'running' ? 'running'
        : receipt.state === 'succeeded' ? 'done' : receipt.state;
      const summary = receipt.installation?.message ?? (receipt.result && 'message' in receipt.result ? receipt.result.message : `Run ${receipt.state}`);
      const sameRun = current?.runId === receipt.runId ? current : undefined;
      const previous = sameRun?.steps ?? [];
      const settled = new Map(receipt.steps.map(step => [step.key, step]));
      const steps: StepView[] = previous.map(step => {
        const completed = settled.get(step.key);
        return completed ? { ...step, status: completed.outcome, note: completed.note } : step;
      });
      for (const step of receipt.steps) if (!previous.some(item => item.key === step.key)) steps.push({ ...step, summary: step.key, status: step.outcome });
      const staleChallenge = receipt.parity?.kind === 'signIn' && receipt.parity.signIn?.state === 'awaiting-user' && statusRevision !== this.statusRevision;
      const failed = receipt.result && 'failed' in receipt.result ? { failed: receipt.result.failed } : {};
      this.update({ run: { ...sameRun, runId: receipt.runId, steps, outcome, summary, ...failed, receipt, challengeCurrent: !staleChallenge }, detail: summary });
      // A run seen ending without its terminal progress changed this Mac too: read status and inspect again.
      if (sameRun?.outcome === 'running' && outcome !== 'running') void this.inspect();
      if (staleChallenge && this.ownsSession(token) && this.state.run?.runId === receipt.runId) await this.refreshRun(receipt.runId);
    } catch {
      // Older agents and legacy runs may have no shared receipt. Preserve their progress and connection.
    } finally {
      if (this.runDiscovery === discovery) this.runDiscovery = null;
    }
  }

  async connect() {
    if (!this.bridge) return;
    const revision = ++this.revision;
    this.generation = null;
    this.runDiscovery = null;
    this.reviewRefresh = false;
    this.earlyReviews.clear();
    this.earlyDisconnects.clear();
    this.earlyStatuses.clear();
    this.unlisten?.();
    this.update({ pending: true, initialReadPending: true, waitingForReport: false, initialReadError: null, connection: 'connecting',
      session: this.state.session + 1, inspection: null, status: null, hello: null, run: null, detail: 'Connecting to the local agent' });
    try {
      const unlisten = await this.bridge.subscribe((event) => this.receive(event));
      if (!this.owns(revision)) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
      if (!this.establish(await this.bridge.invoke('agent_generation'), 'Agent connected', revision)) return;
      await this.takeReviewRequest(revision);
      const canInspect = await this.loadStatus(revision, true);
      await this.discoverRuns();
      if (canInspect && this.owns(revision)) await this.load(revision);
    } catch (error) {
      if (this.owns(revision)) this.update({ connection: 'disconnected', waitingForReport: false, initialReadError: message(error), detail: message(error) });
    } finally {
      if (this.owns(revision)) this.update({ pending: false, initialReadPending: false });
    }
  }

  private showStatus(status: WireStatus) {
    this.statusRevision++;
    const challengeRun = this.concealChallenge();
    if (challengeRun) void this.refreshRun(challengeRun);
    const detail = status.error ? `${status.error}${status.detail ? `: ${status.detail}` : ''}`
      : status.applying ? 'The agent is applying changes'
      : status.paused ? `Automatic apply paused: ${status.paused.reason}` : undefined;
    this.update({ status, waitingForReport: false,
      ...(status.applying || status.error ? { initialReadPending: false }
        : this.state.waitingForReport && !this.state.inspection ? { initialReadPending: true } : {}),
      ...(detail && this.state.run?.outcome !== 'running' ? { detail } : {}) });
  }

  private refused(error: unknown, update: Partial<ViewState> = {}) {
    const detail = message(error);
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : detail;
    // An agent OVERSIZED reply refuses one result on a healthy connection; a record the host could not read
    // disconnects through its own event.
    const offline = /UNAUTHORIZED|MALFORMED|CLOSED|disconnected|closed the connection|incompatible|protocol/i.test(code);
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
          this.update({ waitingForReport: true, detail: 'Waiting for the agent’s first check of this Mac.' });
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
    this.update({ detail: 'Checking this Mac' });
    const statusRevision = this.statusRevision;
    const initialRead = this.state.initialReadPending;
    try {
      const reply = await this.bridge!.invoke('inspect_machine');
      if (!this.current(revision, reply)) return;
      const inspection = checkedReply(decodeInspectResult, reply.data);
      const status = this.statusRevision !== statusRevision ? this.state.status : inspection.status ?? this.state.status;
      this.update({
        inspection, status, initialReadError: null,
        detail: status?.error ? `${status.error}: ${status.detail ?? ''}` : `Checked ${inspection.items.length} items`,
      });
    } catch (error) {
      if (this.owns(revision)) this.refused(error, { inspection: null, ...(initialRead ? { initialReadError: message(error) } : {}) });
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

  async restart() {
    if (!this.bridge || this.state.pending || (this.state.connection === 'connected' && (this.state.run?.outcome === 'running' || this.state.status?.applying === true))) return;
    const revision = ++this.revision;
    this.generation = null;
    this.runDiscovery = null;
    this.reviewRefresh = false;
    this.earlyReviews.clear();
    this.earlyDisconnects.clear();
    this.earlyStatuses.clear();
    this.update({ pending: true, initialReadPending: true, waitingForReport: false, initialReadError: null, connection: 'connecting', session: this.state.session + 1, run: null, inspection: null, status: null, hello: null, detail: 'Restarting the local agent' });
    try {
      if (!this.establish(await this.bridge.invoke('restart_agent'), 'Agent connected', revision)) return;
      await this.takeReviewRequest(revision);
      const canInspect = await this.loadStatus(revision, true);
      await this.discoverRuns();
      if (canInspect && this.owns(revision)) await this.load(revision);
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
      if (event.runId === this.state.run?.runId && this.state.run?.receipt && this.state.run.outcome === 'running') void this.refreshRun(event.runId, true);
      this.refreshReview();
      if ((!this.state.inspection || externalApplyEnded) && !event.status.applying && !this.state.pending) void this.inspect();
      return;
    }
    if (event.event === 'operation-run') {
      if (this.state.run?.runId === event.runId) void this.refreshRun(event.runId, true);
      else void this.discoverRuns(true);
      return;
    }
    let run = this.state.run;
    if (!run && this.runDiscovery
      && (event.progress.type === 'done' || event.progress.type === 'failed' || event.progress.type === 'cancelled')) {
      const discovery = this.runDiscovery;
      if (!discovery.overflow && !discovery.terminalRunIds.has(event.runId)) {
        if (discovery.terminalRunIds.size === MAX_TRACKED_TERMINALS) {
          discovery.overflow = true;
          discovery.terminalRunIds.clear();
        } else discovery.terminalRunIds.add(event.runId);
      }
      return;
    }
    const discoversRun = event.progress.type === 'started' && run?.outcome !== 'running';
    if (event.progress.type === 'started' && run?.outcome !== 'running') {
      run = { runId: event.runId, steps: [], outcome: 'running', summary: 'Applying machine changes' };
      this.update({ status: this.state.status ? { ...this.state.status, applying: true } : null });
    }
    if (!run || run.runId !== event.runId || run.outcome !== 'running') return;
    const next = advance(run, event.progress);
    if (next.outcome === 'running') {
      this.update({ run: next, detail: next.summary });
      if (discoversRun || event.progress.type === 'finished' && event.progress.key.startsWith('skill-intent:')) void this.refreshRun(event.runId);
      return;
    }
    // The machine has changed: look again.
    this.update({ run: next, detail: next.summary, status: this.state.status ? { ...this.state.status, applying: false } : null });
    void this.refreshRun(event.runId);
    void this.inspect();
  }
}
