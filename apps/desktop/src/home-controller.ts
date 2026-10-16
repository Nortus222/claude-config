import type { OperationInput, OperationName, OperationOutput, RunView } from '@nortuscc/agent/operations';
import type { Bridge, HostEvent } from './bridge.ts';
import type { MachineController } from './controller.ts';
import { errorText } from './copy.ts';
import { operation } from './operations.ts';

type Drafts = OperationOutput<'drafts'>['drafts'];
export type HomeState = {
  readonly available: boolean;
  // Newest machine-scope runs; null until read in this session.
  readonly runs: readonly RunView[] | null;
  // Local drafts, including unreadable entries; null until read in this session.
  readonly drafts: Drafts | null;
  readonly pending: boolean;
  readonly error: string | null;
  // The interrupted run whose Abandon awaits confirmation.
  readonly confirming: string | null;
  readonly abandoning: boolean;
  readonly abandonError: string | null;
};
const SCOPE = { kind: 'machine' } as const;
const RUN_LIMIT = 100;
const EMPTY = { runs: null, drafts: null, pending: false, error: null, confirming: null, abandoning: false, abandonError: null } as const;
const publication = (run: RunView) => run.intent.change.kind === 'publishDraft' || run.intent.change.kind === 'announcePublication';

// Runs a person can still review or abandon.
export const interruptedRuns = (runs: readonly RunView[] | null): readonly RunView[] => runs?.filter(run => run.state === 'interrupted') ?? [];
// The newest publication run, when it pushed but left profiles or the tag unannounced.
export function unannouncedRun(runs: readonly RunView[] | null): RunView | null {
  const run = runs?.find(publication);
  if (!run) return null;
  const evidence = run.publication;
  const pushed = run.publicationRecovery?.published === true || evidence?.pushed === true;
  return pushed && (run.publicationRecovery?.action === 'announce' || !!evidence?.pending.length || evidence?.tagged === false) ? run : null;
}
// Readable drafts; unreadable entries are left to Publish.
export const draftCount = (drafts: Drafts | null) => drafts?.filter(draft => 'intents' in draft).length ?? 0;

// Home's own reads (runs and drafts) and Abandon. Reads coalesce, refresh on run events, and a
// session change discards them. It never reads author profiles: that clones the profile repository.
export class HomeController {
  state: HomeState;
  private listeners = new Set<() => void>();
  private disposed = false;
  private epoch = 0;
  private flight: Promise<void> | null = null;
  private dirty = false;
  private unlisten: () => void;
  private unlistenEvents?: () => void;
  private bridge: Bridge | null;
  private machine: MachineController;
  constructor(bridge: Bridge | null, machine: MachineController) {
    this.bridge = bridge; this.machine = machine;
    this.state = { ...EMPTY, available: this.ready() };
    let session = machine.state.session;
    this.unlisten = machine.subscribe(() => {
      if (session !== machine.state.session || !this.ready()) {
        this.epoch++; this.flight = null; this.dirty = false;
        this.update(EMPTY);
      }
      session = machine.state.session;
      this.update({ available: this.ready() });
    });
    if (bridge) void bridge.subscribe(event => this.receive(event)).then(unlisten => {
      if (this.disposed) unlisten(); else this.unlistenEvents = unlisten;
    }).catch(() => {});
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(patch: Partial<HomeState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    // A confirmation lasts only while its run is still listed as interrupted.
    const confirming = this.state.confirming;
    if (confirming && this.state.runs && !interruptedRuns(this.state.runs).some(run => run.runId === confirming)) this.state = { ...this.state, confirming: null, abandonError: null };
    for (const listener of this.listeners) listener();
  }
  private ready() { return !this.disposed && !!this.bridge && this.machine.state.connection === 'connected'; }
  private mark() { return { epoch: this.epoch, token: this.machine.sessionToken() }; }
  private current(mark: ReturnType<HomeController['mark']>) { return !this.disposed && this.epoch === mark.epoch && this.machine.ownsSession(mark.token); }
  private async call<N extends OperationName>(mark: ReturnType<HomeController['mark']>, name: N, input: OperationInput<N>): Promise<OperationOutput<N> | undefined> {
    const reply = await operation(this.bridge!, name, input);
    return this.current(mark) && this.machine.ownsSession(mark.token, reply) ? reply.data : undefined;
  }
  private receive(event: HostEvent) {
    if (event.event === 'operation-run' && this.machine.ownsSession(this.machine.sessionToken(), { generation: event.generation, data: null })) void this.refresh();
  }
  // Reads runs and drafts; a call while a read is in flight joins it and reads once more afterwards.
  refresh(): Promise<void> {
    if (!this.ready()) return Promise.resolve();
    if (this.flight) { this.dirty = true; return this.flight; }
    const epoch = this.epoch;
    const flight = (async () => {
      try { do { this.dirty = false; await this.read(); } while (this.dirty && this.epoch === epoch); }
      finally { if (this.epoch === epoch) this.flight = null; }
    })();
    this.flight = flight;
    return flight;
  }
  private async read() {
    const mark = this.mark();
    this.update({ pending: true });
    const [runs, drafts] = await Promise.allSettled([
      this.call(mark, 'listRuns', { scope: SCOPE, limit: RUN_LIMIT }),
      this.call(mark, 'drafts', { scope: SCOPE }),
    ]);
    if (!this.current(mark)) return;
    const failure = [runs, drafts].find(result => result.status === 'rejected');
    this.update({
      ...(runs.status === 'fulfilled' && runs.value ? { runs: runs.value.runs } : {}),
      ...(drafts.status === 'fulfilled' && drafts.value ? { drafts: drafts.value.drafts } : {}),
      error: failure ? errorText(failure.reason) : null, pending: false,
    });
  }
  confirmAbandon(runId: string) {
    if (this.state.abandoning || !interruptedRuns(this.state.runs).some(run => run.runId === runId)) return;
    this.update({ confirming: runId, abandonError: null });
  }
  cancelAbandon() { if (!this.state.abandoning) this.update({ confirming: null, abandonError: null }); }
  // Abandons the run awaiting confirmation; its finished steps and backups are kept.
  async abandon() {
    const runId = this.state.confirming;
    if (!runId || this.state.abandoning || !this.ready()) return;
    const mark = this.mark();
    this.update({ abandoning: true, abandonError: null });
    try {
      const receipt = await this.call(mark, 'abandonRun', { scope: SCOPE, runId });
      if (receipt?.runId === runId) this.update({ confirming: null, runs: this.state.runs?.map(run => run.runId === runId ? receipt : run) ?? null });
    } catch (error) { if (this.current(mark)) this.update({ abandonError: errorText(error) }); }
    finally { if (this.current(mark)) this.update({ abandoning: false }); }
  }
  dispose() { this.disposed = true; this.epoch++; this.unlisten(); this.unlistenEvents?.(); this.listeners.clear(); }
}
