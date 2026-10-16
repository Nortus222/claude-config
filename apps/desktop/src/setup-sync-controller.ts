import type { ChangePreview, OperationInput, OperationName, OperationOutput, RunView } from '@nortuscc/agent/operations';
import type { Bridge, HostEvent } from './bridge.ts';
import type { MachineController } from './controller.ts';
import { operation } from './operations.ts';

type Review = OperationOutput<'setupReview'>;
type Source = OperationOutput<'inspectSetups'>['items'][number];
export type SetupChoice = Extract<ChangePreview['change'], { kind: 'setupApply' }>['choices'][number];
export type SetupSyncState = {
  profiles: OperationOutput<'inspectProfiles'> | null; profileNotice: string | null;
  native: boolean; connection: MachineController['state']['connection']; sources: readonly Source[]; source: Source | null;
  review: Review | null; choices: readonly SetupChoice[]; preview: ChangePreview | null; run: RunView | null;
  pending: boolean; pagePending: boolean; pageIndex: number; error: string | null; message: string;
  groupErrors: Readonly<Record<string, string>>;
  eligibility: { read: boolean; refetch: boolean; choose: boolean; preview: boolean; apply: boolean; cancel: boolean; browse: boolean };
};
const SCOPE = { kind: 'machine' } as const;
const PAGE_SIZE = 100;
const MAX_CHOICES = 1000;
const MAX_RUN_PAGES = 5;
const active = (run: RunView | null) => run?.state === 'accepted' || run?.state === 'running';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// Choices survive paging, while connection changes discard every preview and re-read the durable run.
export class SetupSyncController {
  state: SetupSyncState;
  private listeners = new Set<() => void>();
  private disposed = false;
  private visible = false;
  private epoch = 0;
  private runRead = 0;
  private cursors: (string | undefined)[] = [undefined];
  private issued = new Map<string, Pick<Review['rows'][number], 'held' | 'conflict'>>();
  private unlisten: () => void;
  private unlistenEvents?: () => void;
  private bridge: Bridge | null;
  private machine: MachineController;
  private maintenance: () => boolean;
  private inMaintenance = false;
  constructor(bridge: Bridge | null, machine: MachineController, options: { maintenance?: () => boolean } = {}) {
    this.bridge = bridge; this.machine = machine; this.maintenance = options.maintenance ?? (() => false);
    this.state = { profiles: null, profileNotice: null, native: !!bridge, connection: machine.state.connection, sources: [], source: null, review: null, choices: [], preview: null, run: null,
      pending: false, pagePending: false, pageIndex: 0, error: null, message: '', groupErrors: {},
      eligibility: { read: false, refetch: false, choose: false, preview: false, apply: false, cancel: false, browse: false } };
    let session = machine.state.session, connection = machine.state.connection;
    this.unlisten = machine.subscribe(() => {
      const changed = session !== machine.state.session || connection !== machine.state.connection;
      session = machine.state.session; connection = machine.state.connection;
      if (changed) {
        this.epoch++; this.runRead++; this.issued.clear(); this.cursors = [undefined];
        this.update({ connection, review: null, choices: [], preview: null, pending: false, pagePending: false, groupErrors: {} });
        if (connection === 'connected') {
          if (this.state.run) void this.readRun(this.state.run.runId);
          else if (this.visible) void this.discoverRun();
        }
      } else this.update({});
    });
    if (bridge) void bridge.subscribe(event => this.receive(event)).then(unlisten => {
      if (this.disposed) unlisten(); else this.unlistenEvents = unlisten;
    }).catch(error => this.update({ error: message(error) }));
    this.update({});
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(patch: Partial<SetupSyncState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    const connected = !!this.bridge && this.machine.state.connection === 'connected';
    const free = connected && !this.maintenance() && !this.machine.state.pending && !this.machine.state.initialReadPending
      && !this.machine.state.status?.applying && this.machine.state.run?.outcome !== 'running' && !active(this.state.run);
    const idle = free && !this.state.pending && !this.state.pagePending;
    const choose = idle && !!this.state.review && !!this.state.source?.trusted && this.machine.state.status?.trusted !== false;
    this.state = { ...this.state, eligibility: { read: idle, refetch: idle && !!this.state.source?.trusted, choose,
      preview: choose && this.state.choices.length > 0, apply: idle && !!this.state.preview && (this.state.preview.change.kind === 'followProfile' || this.machine.state.status?.trusted !== false),
      cancel: connected && active(this.state.run), browse: choose } };
    for (const listener of this.listeners) listener();
  }
  private mark() { return { epoch: this.epoch, token: this.machine.sessionToken() }; }
  private current(mark: ReturnType<SetupSyncController['mark']>) { return !this.disposed && this.epoch === mark.epoch && this.machine.ownsSession(mark.token); }
  private async call<N extends OperationName>(mark: ReturnType<SetupSyncController['mark']>, name: N, input: OperationInput<N>): Promise<OperationOutput<N> | undefined> {
    if (!this.current(mark)) return undefined;
    const reply = await operation(this.bridge!, name, input);
    return this.current(mark) && this.machine.ownsSession(mark.token, reply) ? reply.data : undefined;
  }
  enter() { this.visible = true; if (!this.state.run && !this.state.preview) void this.discoverRun(); if (!this.state.review && !this.state.preview) void this.reload(); }
  leave() { this.visible = false; }
  refresh() {
    const maintenance = this.maintenance(), entering = maintenance && !this.inMaintenance;
    this.inMaintenance = maintenance;
    if (entering) this.invalidate(); else this.update({});
  }
  invalidate() { this.epoch++; this.issued.clear(); this.update({ review: null, preview: null, choices: [], pending: false, pagePending: false, groupErrors: {} }); }
  private async discoverRun() {
    if (!this.bridge || this.machine.state.connection !== 'connected') return;
    const mark = this.mark(), serial = ++this.runRead;
    try {
      let before: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < MAX_RUN_PAGES; page++) {
        const result = await this.call(mark, 'listRuns', { scope: SCOPE, limit: PAGE_SIZE, ...(before ? { before } : {}) });
        if (!result || serial !== this.runRead || active(this.state.run) || this.state.pending) return;
        const run = result.runs.find(run => run.intent.change.kind === 'setupApply' || run.intent.change.kind === 'followProfile');
        if (run) { this.update({ run, preview: null }); await this.readRun(run.runId); return; }
        if (!result.nextBefore || cursors.has(result.nextBefore)) return;
        before = result.nextBefore;
        cursors.add(before);
      }
    } catch (error) { if (this.current(mark) && serial === this.runRead) this.update({ error: message(error) }); }
  }
  private async readRun(runId: string) {
    if (!this.bridge || this.machine.state.connection !== 'connected') return;
    const mark = this.mark(), serial = ++this.runRead;
    try {
      const run = await this.call(mark, 'getRun', { scope: SCOPE, runId });
      if (run?.runId === runId && serial === this.runRead && this.state.run?.runId === runId) {
        const switched = active(this.state.run) && run.state === 'succeeded' && run.intent.change.kind === 'followProfile';
        this.update({ run, preview: null, message: `Run ${run.state}` });
        if (switched) { this.invalidate(); await this.reload(); }
      }
    } catch (error) { if (this.current(mark) && serial === this.runRead) this.update({ error: message(error) }); }
  }
  private receive(event: HostEvent) {
    if (!this.machine.ownsSession(this.machine.sessionToken(), { generation: event.generation, data: null })) return;
    const runId = this.state.run?.runId;
    if (runId && (event.event === 'operation-run' || event.event === 'status' || event.event === 'progress') && event.runId === runId) void this.readRun(runId);
    else if (event.event === 'operation-run' && this.visible && !this.state.run) void this.discoverRun();
  }
  async reload() { await this.load(false); }
  async refetch() { if (this.state.eligibility.refetch) await this.load(true); }
  async selectSource(setupId: string) {
    if (!this.state.eligibility.read) return;
    const source = this.state.sources.find(source => source.setupId === setupId);
    if (!source) return;
    this.invalidate(); this.update({ source }); await this.reload();
  }
  private async load(refetch: boolean) {
    if (!this.state.eligibility.read) return;
    this.epoch++; this.issued.clear(); this.cursors = [undefined];
    const mark = this.mark(); this.update({ pending: true, review: null, preview: null, choices: [], pageIndex: 0, error: null, profiles: null, profileNotice: null, groupErrors: {} });
    try {
      let profiles: SetupSyncState['profiles'] = null;
      try {
        profiles = await this.call(mark, 'inspectProfiles', { scope: SCOPE }) ?? null;
      } catch (error) {
        if (this.current(mark)) this.update({ profileNotice: `Profiles could not be listed: ${message(error)}. Reload to retry.` });
      }
      if (!this.current(mark)) return;
      this.update({ profiles });
      const sources: Source[] = []; let cursor: string | undefined;
      do {
        const result = await this.call(mark, 'inspectSetups', { scope: SCOPE, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
        if (!result) return; sources.push(...result.items); cursor = result.nextCursor ?? undefined;
      } while (cursor);
      const source = sources.find(source => profiles?.followed && source.setupId === (profiles.followed.setupId ?? 'local')) ?? sources.find(source => source.setupId === this.state.source?.setupId) ?? sources.find(source => source.trusted) ?? sources[0] ?? null;
      this.update({ sources, source });
      if (!source?.trusted) { this.update({ message: source ? 'Trust this repository in Settings before reviewing changes.' : 'No setup is available.' }); return; }
      const review = await this.call(mark, 'setupReview', { scope: SCOPE, setupId: source.setupId, limit: PAGE_SIZE, refetch });
      if (review) { for (const row of review.rows) this.issued.set(row.itemId, { held: row.held, conflict: row.conflict }); this.update({ review, message: refetch ? 'Incoming changes refetched. Review before applying.' : 'Cached Setup ready.' }); }
    } catch (error) { if (this.current(mark)) this.update({ error: message(error) }); }
    finally { if (this.current(mark)) { this.update({ pending: false }); await this.discoverRun(); } }
  }
  choose(choice: SetupChoice) {
    if (!this.state.eligibility.choose) return;
    const row = this.issued.get(choice.itemId);
    if (!row || choice.action === 'takeTheirs' && !row.conflict || choice.action === 'release' && !row.held) return;
    if (!this.state.choices.some(c => c.itemId === choice.itemId) && this.state.choices.length >= MAX_CHOICES) return;
    this.update({ choices: [...this.state.choices.filter(c => c.itemId !== choice.itemId), choice], preview: null, groupErrors: {}, error: null });
  }
  async page(direction: 'next' | 'previous') {
    const review = this.state.review;
    if (!this.state.eligibility.browse || !review || direction === 'next' && !review.nextCursor || direction === 'previous' && this.state.pageIndex === 0) return;
    const index = this.state.pageIndex + (direction === 'next' ? 1 : -1);
    const cursor = direction === 'next' ? review.nextCursor! : this.cursors[index];
    const mark = this.mark(); this.update({ pagePending: true, error: null });
    try {
      const page = await this.call(mark, 'setupReview', { scope: SCOPE, setupId: review.setupId, limit: PAGE_SIZE, refetch: false, ...(cursor ? { cursor } : {}) });
      if (!page) return;
      if (page.generation !== review.generation || JSON.stringify(page.revision) !== JSON.stringify(review.revision)) throw new Error('Setup changed. Reload before choosing.');
      this.cursors[index] = cursor;
      const selected = new Set(this.state.choices.map(choice => choice.itemId));
      this.issued = new Map([...this.issued].filter(([itemId]) => selected.has(itemId)));
      for (const row of page.rows) this.issued.set(row.itemId, { held: row.held, conflict: row.conflict });
      this.update({ review: page, pageIndex: index });
    } catch (error) { if (this.current(mark)) { this.issued.clear(); this.update({ review: null, preview: null, choices: [], error: message(error) }); } }
    finally { if (this.current(mark)) this.update({ pagePending: false }); }
  }
  async switchProfile(profile: string) {
    if (!this.state.eligibility.read || !this.state.profiles?.available.some(item => item.name === profile)) return;
    const followed = this.state.profiles.followed;
    if (!followed) return;
    // Another profile in the same repository follows Git until its own share link is chosen.
    await this.prepare({ kind: 'followProfile', repoUrl: followed.repoUrl, profile, setupId: null });
  }
  async followSharedLink(link: string) {
    if (!this.state.eligibility.read) return;
    const setupId = link.trim().replace(/^nortuscc:\/\/follow\//, '');
    const mark = this.mark(); this.update({ pending: true, preview: null, error: null });
    let change: Extract<ChangePreview['change'], { kind: 'followProfile' }> | undefined;
    try {
      const setup = await this.call(mark, 'inspectShareLink', { scope: SCOPE, setupId });
      if (setup) {
        if (setup.access !== 'readable') throw new Error(setup.access === 'denied' ? 'Git read access denied. No subscription was created.' : 'Repository access is unreachable. Try again when it is available.');
        change = { kind: 'followProfile', repoUrl: setup.repoUrl, profile: setup.profile, setupId: setup.setupId };
      }
    } catch (error) { if (this.current(mark)) this.update({ error: message(error) }); }
    finally { if (this.current(mark)) this.update({ pending: false }); }
    if (change && this.current(mark)) await this.prepare(change);
  }
  async preview() {
    const review = this.state.review;
    if (!this.state.eligibility.preview || !review) return;
    await this.prepare({ kind: 'setupApply', setupId: review.setupId, revision: review.revision, choices: this.state.choices });
  }
  private async prepare(change: ChangePreview['change']) {
    this.runRead++;
    const mark = this.mark(); this.update({ pending: true, preview: null, error: null, groupErrors: {} });
    try {
      const preview = await this.call(mark, 'previewChange', { scope: SCOPE, change });
      if (preview) this.update({ preview });
    } catch (error) {
      if (this.current(mark)) {
        const text = message(error);
        const groupErrors = Object.fromEntries((this.state.review?.pinGroups ?? []).filter(group => `Choices for ${group.source} must match: its items share one pin.` === text).map(group => [group.source, text]));
        this.update({ error: text, groupErrors });
      }
    } finally { if (this.current(mark)) this.update({ pending: false }); }
  }
  async apply() {
    const preview = this.state.preview;
    if (!this.state.eligibility.apply || !preview) return;
    this.runRead++;
    const mark = this.mark(); this.update({ pending: true, preview: null, error: null });
    let switched = false;
    try {
      const result = await this.call(mark, 'applyChange', { scope: SCOPE, planId: preview.planId, requestId: crypto.randomUUID() });
      if (!result) return;
      if (result.status === 'stale') this.update({ message: 'Setup changed. Preview again before applying.' });
      else {
        this.update({ run: result.run, choices: [], message: `Run ${result.run.state}` });
        switched = preview.change.kind === 'followProfile' && result.run.state === 'succeeded';
        if (!switched) await this.readRun(result.run.runId);
      }
    } catch (error) { if (this.current(mark)) this.update({ error: `${message(error)}. Apply completion is unconfirmed. Reload to inspect runs before retrying.` }); }
    finally { if (this.current(mark)) { this.update({ pending: false }); if (switched) { this.invalidate(); await this.reload(); } } }
  }
  async repreview() {
    const run = this.state.run;
    if (run?.state !== 'interrupted' || !this.state.eligibility.read) return;
    await this.prepare(run.intent.change);
  }
  async abandon() { await this.runAction('abandonRun'); }
  async cancel() { await this.runAction('cancelRun'); }
  private async runAction(name: 'abandonRun' | 'cancelRun') {
    const run = this.state.run;
    if (!run || this.state.pending || (name === 'abandonRun' ? run.state !== 'interrupted' || !this.state.eligibility.read : !this.state.eligibility.cancel)) return;
    const mark = this.mark(); this.runRead++; this.update({ pending: true, preview: null, error: null });
    try {
      const result = await this.call(mark, name, { scope: SCOPE, runId: run.runId });
      if (result?.runId === run.runId) { this.runRead++; this.update({ run: result, message: `Run ${result.state}` }); }
    } catch (error) { if (this.current(mark)) this.update({ error: message(error) }); }
    finally { if (this.current(mark)) this.update({ pending: false }); }
  }
  dispose() { this.disposed = true; this.epoch++; this.runRead++; this.unlisten(); this.unlistenEvents?.(); this.listeners.clear(); }
}
