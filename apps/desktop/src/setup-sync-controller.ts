import type { InspectResult } from '@nortuscc/agent/ipc/protocol';
import type { ChangePreview, OperationInput, OperationName, OperationOutput, RunView } from '@nortuscc/agent/operations';
import type { Bridge, HostEvent } from './bridge.ts';
import type { MachineController } from './controller.ts';
import { errorText } from './copy.ts';
import { operation } from './operations.ts';

type Review = OperationOutput<'setupReview'>;
type Source = OperationOutput<'inspectSetups'>['items'][number];
export type SetupChoice = Extract<ChangePreview['change'], { kind: 'setupApply' }>['choices'][number];
export type SetupSyncState = {
  profiles: OperationOutput<'inspectProfiles'> | null; profileNotice: string | null;
  native: boolean; connection: MachineController['state']['connection']; sources: readonly Source[]; source: Source | null;
  review: Review | null; choices: readonly SetupChoice[]; preview: ChangePreview | null; run: RunView | null;
  pending: boolean; pagePending: boolean; pageIndex: number; error: string | null; message: string;
  // A refused Preview of the review's choices, shown beside its button.
  previewError: string | null;
  groupErrors: Readonly<Record<string, string>>;
  // The machine inspection, mirrored from the machine controller; its `apply` items are "On this Mac".
  inspection: InspectResult | null;
  // `apply` items the user unchecked; the rest are previewed as one reconcile.
  excluded: readonly string[];
  // A refused Preview of this Mac's items, shown beside its button.
  localError: string | null;
  // Why the preview was replaced, shown in the preview panel.
  previewNotice: string | null;
  // The profile a switch preview is for, so the profile select shows it while the preview stands.
  switchTarget: string | null;
  // Abandon of the interrupted run awaits its one confirmation.
  confirmingAbandon: boolean;
  eligibility: { read: boolean; refetch: boolean; choose: boolean; preview: boolean; apply: boolean; cancel: boolean; browse: boolean; local: boolean; previewLocal: boolean };
};
const SCOPE = { kind: 'machine' } as const;
const PAGE_SIZE = 100;
const MAX_CHOICES = 1000;
const MAX_RUN_PAGES = 5;
const STALE = 'This Mac changed. Review the updated plan.';
const PROFILE_CHANGED = 'Your profile changed. Review the new values and choose again.';
// What a person saw of a row when choosing for it.
const seen = (row: Review['rows'][number]) => JSON.stringify([row.change, row.held, row.conflict, row.before ?? null, row.after ?? null, row.mine ?? null]);
// Runs that change this Mac; the Changes page shows one while it is active or interrupted.
export const MACHINE_KINDS: ReadonlySet<string> = new Set(['setupApply', 'followProfile', 'reconcile', 'uninstallConfig', 'update', 'addSkill', 'machineIntent', 'syncDecision']);
const active = (run: RunView | null) => run?.state === 'accepted' || run?.state === 'running';
// A finished setup apply or a successful follow changes what is incoming, so the review is re-read.
const settles = (run: RunView) => !active(run) && (run.intent.change.kind === 'setupApply' || run.intent.change.kind === 'followProfile' && run.state === 'succeeded');
const applyKeys = (inspection: InspectResult | null) => inspection?.items.filter(item => item.disposition === 'apply').map(item => item.key) ?? [];

// One review page's counts, shared by Home, the Changes badge and its heading: rows to decide (changed
// and not on hold) and rows on hold. Unchanged rows (overrides, pin siblings) are neither.
export function incomingCounts(review: Pick<Review, 'rows'> | null): { incoming: number; held: number } {
  const rows = review?.rows ?? [];
  return { incoming: rows.filter(row => row.change !== 'unchanged' && !row.held).length, held: rows.filter(row => row.held).length };
}

// The keys a local Preview sends as the reconcile's `only`: every `apply` item the user kept checked.
export const selectedLocal = (state: Pick<SetupSyncState, 'inspection' | 'excluded'>) => {
  const excluded = new Set(state.excluded);
  return applyKeys(state.inspection).filter(key => !excluded.has(key));
};

// Owns the Changes page: incoming changes from the followed profile (setupApply, follow/switch) and this
// Mac's own pending items (reconcile), with one preview and one durable run at a time. Choices survive
// paging, while connection changes discard every preview and re-read the durable run.
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
  // The session the review was last loaded in, so an entered page loads it once per session as soon as it can.
  private loaded: number | null = null;
  // The request of an Apply whose reply was lost; Reload looks for its run.
  private lost: string | null = null;
  constructor(bridge: Bridge | null, machine: MachineController, options: { maintenance?: () => boolean } = {}) {
    this.bridge = bridge; this.machine = machine; this.maintenance = options.maintenance ?? (() => false);
    this.state = { profiles: null, profileNotice: null, native: !!bridge, connection: machine.state.connection, sources: [], source: null, review: null, choices: [], preview: null, run: null,
      pending: false, pagePending: false, pageIndex: 0, error: null, message: '', groupErrors: {}, previewError: null,
      inspection: machine.state.inspection, excluded: [], localError: null, previewNotice: null, switchTarget: null, confirmingAbandon: false,
      eligibility: { read: false, refetch: false, choose: false, preview: false, apply: false, cancel: false, browse: false, local: false, previewLocal: false } };
    let session = machine.state.session, connection = machine.state.connection;
    this.unlisten = machine.subscribe(() => {
      const changed = session !== machine.state.session || connection !== machine.state.connection;
      session = machine.state.session; connection = machine.state.connection;
      const inspection = this.mirror();
      if (changed) {
        this.epoch++; this.runRead++; this.issued.clear(); this.cursors = [undefined];
        this.update({ ...inspection, connection, review: null, choices: [], preview: null, pending: false, pagePending: false, groupErrors: {}, previewError: null, localError: null, previewNotice: null, switchTarget: null });
        if (connection === 'connected') {
          if (this.state.run) void this.readRun(this.state.run.runId);
          else if (this.visible) void this.discoverRun();
        }
      } else this.update(inspection);
      this.autoload();
    });
    if (bridge) void bridge.subscribe(event => this.receive(event)).then(unlisten => {
      if (this.disposed) unlisten(); else this.unlistenEvents = unlisten;
    }).catch(error => this.update({ error: errorText(error) }));
    this.update({});
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  // A new inspection keeps only the exclusions of items still waiting to apply.
  private mirror(): Partial<SetupSyncState> {
    const inspection = this.machine.state.inspection;
    if (inspection === this.state.inspection) return {};
    const keys = new Set(applyKeys(inspection));
    return { inspection, excluded: this.state.excluded.filter(key => keys.has(key)) };
  }
  private update(patch: Partial<SetupSyncState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    // The confirmation lasts only while its run stays interrupted.
    if (this.state.confirmingAbandon && this.state.run?.state !== 'interrupted') this.state = { ...this.state, confirmingAbandon: false };
    const connected = !!this.bridge && this.machine.state.connection === 'connected';
    const free = connected && !this.maintenance() && !this.machine.state.pending && !this.machine.state.initialReadPending
      && !this.machine.state.status?.applying && this.machine.state.run?.outcome !== 'running' && !active(this.state.run);
    const idle = free && !this.state.pending && !this.state.pagePending;
    const choose = idle && !!this.state.review && !!this.state.source?.trusted && this.machine.state.status?.trusted !== false;
    const local = idle && !!this.state.inspection;
    const kind = this.state.preview?.change.kind;
    // A follow and this Mac's own items do not depend on trusting the followed repository.
    const apply = idle && !!kind && (kind === 'followProfile' || kind === 'reconcile' || this.machine.state.status?.trusted !== false);
    this.state = { ...this.state, eligibility: { read: idle, refetch: idle && !!this.state.source?.trusted, choose,
      preview: choose && this.state.choices.length > 0, apply, cancel: connected && active(this.state.run), browse: choose,
      local, previewLocal: local && !this.state.inspection!.profile.issues.length && selectedLocal(this.state).length > 0 } };
    for (const listener of this.listeners) listener();
  }
  // An entered page without a review loads it the first time reading is allowed in a session: after the
  // first connection, a Reconnect, the machine's first inspection, or the end of maintenance or a run.
  // Called on those outside changes only, never mid-action.
  private autoload() {
    if (this.visible && !this.state.review && this.state.eligibility.read && this.loaded !== this.machine.state.session) void this.load(false);
  }
  private mark() { return { epoch: this.epoch, token: this.machine.sessionToken() }; }
  private current(mark: ReturnType<SetupSyncController['mark']>) { return !this.disposed && this.epoch === mark.epoch && this.machine.ownsSession(mark.token); }
  private async call<N extends OperationName>(mark: ReturnType<SetupSyncController['mark']>, name: N, input: OperationInput<N>): Promise<OperationOutput<N> | undefined> {
    if (!this.current(mark)) return undefined;
    const reply = await operation(this.bridge!, name, input);
    return this.current(mark) && this.machine.ownsSession(mark.token, reply) ? reply.data : undefined;
  }
  // Loads the review when there is none, keeping a follow preview requested just before entering.
  enter() { this.visible = true; if (!this.state.run) void this.discoverRun(); if (!this.state.review) void this.load(false); }
  leave() { this.visible = false; }
  refresh() {
    const maintenance = this.maintenance(), entering = maintenance && !this.inMaintenance;
    // Leaving maintenance lets an entered page load the review it discarded.
    if (!maintenance && this.inMaintenance) this.loaded = null;
    this.inMaintenance = maintenance;
    if (entering) this.invalidate(); else this.update({});
    this.autoload();
  }
  invalidate() { this.epoch++; this.issued.clear(); this.update({ review: null, preview: null, choices: [], pending: false, pagePending: false, groupErrors: {}, previewError: null, localError: null, previewNotice: null, switchTarget: null }); }
  // Adopts the run of an Apply whose reply was lost, whatever its state, else the newest machine run that
  // is active or interrupted. Another finished run found here is history, not something this window did.
  private async discoverRun() {
    if (!this.bridge || this.machine.state.connection !== 'connected') return;
    const mark = this.mark(), serial = ++this.runRead;
    try {
      let before: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < MAX_RUN_PAGES; page++) {
        const result = await this.call(mark, 'listRuns', { scope: SCOPE, limit: PAGE_SIZE, ...(before ? { before } : {}) });
        if (!result || serial !== this.runRead || active(this.state.run) || this.state.pending) return;
        const lost = this.lost === null ? undefined : result.runs.find(run => run.intent.requestId === this.lost);
        if (lost && !active(lost)) { this.lost = null; this.update({ run: lost }); await this.finished(lost); return; }
        const run = lost ?? result.runs.find(run => MACHINE_KINDS.has(run.intent.change.kind) && (active(run) || run.state === 'interrupted'));
        if (run) { if (run === lost) this.lost = null; this.update({ run, ...(active(run) ? { preview: null } : {}) }); await this.readRun(run.runId); return; }
        if (!result.nextBefore || cursors.has(result.nextBefore)) return;
        before = result.nextBefore;
        cursors.add(before);
      }
    } catch (error) { if (this.current(mark) && serial === this.runRead) this.update({ error: errorText(error) }); }
  }
  private async readRun(runId: string) {
    if (!this.bridge || this.machine.state.connection !== 'connected') return;
    const mark = this.mark(), serial = ++this.runRead;
    try {
      const run = await this.call(mark, 'getRun', { scope: SCOPE, runId });
      if (run?.runId === runId && serial === this.runRead && this.state.run?.runId === runId) {
        const finished = active(this.state.run) && !active(run);
        this.update({ run, ...(active(run) ? { preview: null } : {}) });
        if (finished) await this.finished(run); else this.autoload();
      }
    } catch (error) { if (this.current(mark) && serial === this.runRead) this.update({ error: errorText(error) }); }
  }
  // A run this window saw finish changed this Mac: re-read what is incoming when it can have changed,
  // and re-inspect so "On this Mac" shows what is left.
  private async finished(run: RunView) {
    if (settles(run)) { this.invalidate(); await this.reload(); }
    void this.machine.inspect();
  }
  private receive(event: HostEvent) {
    if (!this.machine.ownsSession(this.machine.sessionToken(), { generation: event.generation, data: null })) return;
    const runId = this.state.run?.runId;
    if (runId && (event.event === 'operation-run' || event.event === 'status' || event.event === 'progress') && event.runId === runId) void this.readRun(runId);
    else if (event.event === 'operation-run' && this.visible && !active(this.state.run)) void this.discoverRun();
  }
  // Re-reads incoming changes and inspects this Mac again.
  async reload() {
    const loading = this.load(false);
    await Promise.all([loading, this.machine.inspect()]);
  }
  async refetch() { if (this.state.eligibility.refetch) await this.load(true); }
  async selectSource(setupId: string) {
    if (!this.state.eligibility.read) return;
    const source = this.state.sources.find(source => source.setupId === setupId);
    if (!source) return;
    this.invalidate(); this.update({ source }); await this.reload();
  }
  private async load(refetch: boolean) {
    if (!this.state.eligibility.read) return;
    this.loaded = this.machine.state.session;
    this.epoch++; this.issued.clear(); this.cursors = [undefined];
    // A follow preview does not depend on the review, so a reload keeps it.
    const follow = this.state.preview?.change.kind === 'followProfile';
    const mark = this.mark(); this.update({ pending: true, review: null, choices: [], pageIndex: 0, error: null, profiles: null, profileNotice: null, groupErrors: {}, previewError: null,
      ...(follow ? {} : { preview: null, previewNotice: null, switchTarget: null }) });
    try {
      let profiles: SetupSyncState['profiles'] = null;
      try {
        profiles = await this.call(mark, 'inspectProfiles', { scope: SCOPE }) ?? null;
      } catch (error) {
        if (this.current(mark)) this.update({ profileNotice: `Profiles could not be listed: ${errorText(error)}. Reload to retry.` });
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
      if (!source?.trusted) { this.update({ message: source ? 'Trust this repository in Settings before reviewing incoming changes.' : 'No profile is available to review.' }); return; }
      const review = await this.call(mark, 'setupReview', { scope: SCOPE, setupId: source.setupId, limit: PAGE_SIZE, refetch });
      if (review) { for (const row of review.rows) this.issued.set(row.itemId, { held: row.held, conflict: row.conflict }); this.update({ review, message: refetch ? 'Checked for new changes. Review them before applying.' : '' }); }
    } catch (error) { if (this.current(mark)) this.update({ error: errorText(error) }); }
    finally { if (this.current(mark)) { this.update({ pending: false }); await this.discoverRun(); } }
  }
  // Staging a choice discards only a preview of the earlier choices.
  private staged(choices: SetupChoice[]): Partial<SetupSyncState> {
    const spent = this.state.preview?.change.kind === 'setupApply';
    return { choices, groupErrors: {}, previewError: null, error: null, ...(spent ? { preview: null, previewNotice: null } : {}) };
  }
  choose(choice: SetupChoice) {
    if (!this.state.eligibility.choose) return;
    const row = this.issued.get(choice.itemId);
    if (!row || choice.action === 'takeTheirs' && !row.conflict || choice.action === 'release' && !row.held) return;
    if (!this.state.choices.some(c => c.itemId === choice.itemId) && this.state.choices.length >= MAX_CHOICES) return;
    this.update(this.staged([...this.state.choices.filter(c => c.itemId !== choice.itemId), choice]));
  }
  // Stages one action for many rows on this page: one pin group, or every incoming row with its
  // pin-group siblings so the group's choices match.
  chooseAll(action: 'accept' | 'hold', source?: string) {
    const review = this.state.review;
    if (!this.state.eligibility.choose || !review) return;
    const onPage = new Set(review.rows.map(row => row.itemId));
    const ids = new Set(source !== undefined ? review.pinGroups.find(group => group.source === source)?.itemIds ?? []
      : review.rows.filter(row => row.change !== 'unchanged').map(row => row.itemId));
    if (source === undefined) for (const group of review.pinGroups) if (group.itemIds.some(id => ids.has(id))) for (const id of group.itemIds) ids.add(id);
    const staged = new Map(this.state.choices.map(choice => [choice.itemId, choice]));
    for (const itemId of ids) if (onPage.has(itemId) && this.issued.has(itemId)) staged.set(itemId, { itemId, action });
    if (staged.size > MAX_CHOICES) return;
    this.update(this.staged([...staged.values()]));
  }
  // Includes or leaves out one item waiting to apply on this Mac.
  toggleLocal(key: string) {
    if (!this.state.eligibility.local || !applyKeys(this.state.inspection).includes(key)) return;
    const excluded = this.state.excluded.includes(key) ? this.state.excluded.filter(k => k !== key) : [...this.state.excluded, key];
    const spent = this.state.preview?.change.kind === 'reconcile';
    this.update({ excluded, localError: null, ...(spent ? { preview: null, previewNotice: null } : {}) });
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
      if (page.generation !== review.generation || JSON.stringify(page.revision) !== JSON.stringify(review.revision)) throw new Error('Your profile changed. Reload before choosing.');
      this.cursors[index] = cursor;
      const selected = new Set(this.state.choices.map(choice => choice.itemId));
      this.issued = new Map([...this.issued].filter(([itemId]) => selected.has(itemId)));
      for (const row of page.rows) this.issued.set(row.itemId, { held: row.held, conflict: row.conflict });
      this.update({ review: page, pageIndex: index });
    } catch (error) { if (this.current(mark)) { this.issued.clear(); this.update({ review: null, preview: null, choices: [], error: errorText(error) }); } }
    finally { if (this.current(mark)) this.update({ pagePending: false }); }
  }
  async switchProfile(profile: string) {
    if (!this.state.eligibility.read || !this.state.profiles?.available.some(item => item.name === profile)) return;
    const followed = this.state.profiles.followed;
    if (!followed) return;
    this.update({ switchTarget: profile });
    await this.followRepository(followed.repoUrl, profile);
  }
  // Previews following `profile` from a Git repository. Another profile follows Git until its own share
  // link is chosen.
  async followRepository(repoUrl: string, profile: string) {
    if (!this.state.eligibility.read) return;
    await this.prepare({ kind: 'followProfile', repoUrl, profile, setupId: null });
  }
  async followSharedLink(link: string) {
    if (!this.state.eligibility.read) return;
    const setupId = link.trim().replace(/^nortuscc:\/\/follow\//, '');
    const mark = this.mark(); this.update({ pending: true, preview: null, previewNotice: null, switchTarget: null, error: null });
    let change: Extract<ChangePreview['change'], { kind: 'followProfile' }> | undefined;
    try {
      const setup = await this.call(mark, 'inspectShareLink', { scope: SCOPE, setupId });
      if (setup) {
        if (setup.access !== 'readable') throw new Error(setup.access === 'denied' ? 'Git read access denied. No subscription was created.' : 'Repository access is unreachable. Try again when it is available.');
        change = { kind: 'followProfile', repoUrl: setup.repoUrl, profile: setup.profile, setupId: setup.setupId };
      }
    } catch (error) { if (this.current(mark)) this.update({ error: errorText(error) }); }
    finally { if (this.current(mark)) this.update({ pending: false }); }
    if (change && this.current(mark)) await this.prepare(change);
  }
  async preview() {
    const review = this.state.review;
    if (!this.state.eligibility.preview || !review) return;
    await this.prepare({ kind: 'setupApply', setupId: review.setupId, revision: review.revision, choices: this.state.choices });
  }
  // Previews applying this Mac's checked items as one reconcile.
  async previewLocal() {
    if (!this.state.eligibility.previewLocal) return;
    await this.prepare({ kind: 'reconcile', only: selectedLocal(this.state) });
  }
  // Discards the preview without applying it.
  cancelPreview() {
    if (!this.state.preview || this.state.pending) return;
    this.update({ preview: null, previewNotice: null, switchTarget: null });
  }
  private async prepare(change: ChangePreview['change']) {
    this.runRead++;
    const follow = change.kind === 'followProfile';
    const mark = this.mark(); this.update({ pending: true, preview: null, previewNotice: null, error: null, groupErrors: {}, previewError: null, localError: null,
      ...(follow ? {} : { switchTarget: null }) });
    try {
      const preview = await this.call(mark, 'previewChange', { scope: SCOPE, change });
      if (preview) this.update({ preview });
    } catch (error) {
      if (this.current(mark)) {
        const text = errorText(error);
        const groupErrors = Object.fromEntries((this.state.review?.pinGroups ?? []).filter(group => `Choices for ${group.source} must match: its items share one pin.` === text).map(group => [group.source, text]));
        this.update({ groupErrors, switchTarget: null, ...(change.kind === 'setupApply' && this.state.review ? { previewError: text } : change.kind === 'reconcile' ? { localError: text } : { error: text }) });
      }
    } finally {
      if (this.current(mark)) {
        this.update({ pending: false });
        // A follow requested before the page was entered left the review unread.
        if (follow && this.visible && !this.state.review) await this.reload();
      }
    }
  }
  async apply() {
    const preview = this.state.preview;
    if (!this.state.eligibility.apply || !preview) return;
    this.runRead++;
    const target = this.state.switchTarget;
    const mark = this.mark(); this.update({ pending: true, preview: null, previewNotice: null, switchTarget: null, error: null });
    let finished: RunView | undefined, changed: { rows: Map<string, string>; choices: readonly SetupChoice[] } | undefined;
    const requestId = crypto.randomUUID();
    this.lost = null;
    try {
      const result = await this.call(mark, 'applyChange', { scope: SCOPE, planId: preview.planId, requestId });
      if (!result) return;
      // Nothing ran. Incoming choices were made against values the agent has since replaced, so its
      // replacement is dropped and the review re-read; a follow or this Mac's items adopt the re-plan.
      if (result.status === 'stale' && preview.change.kind === 'setupApply') {
        changed = { rows: new Map((this.state.review?.rows ?? []).map(row => [row.itemId, seen(row)])), choices: preview.change.choices };
      } else if (result.status === 'stale') {
        this.update({ preview: result.preview, previewNotice: STALE, ...(result.preview.change.kind === 'followProfile' ? { switchTarget: target } : {}) });
        if (result.preview.change.kind === 'reconcile') void this.machine.inspect();
      } else {
        this.update({ run: result.run, ...(preview.change.kind === 'setupApply' ? { choices: [] } : {}), message: '' });
        if (active(result.run)) await this.readRun(result.run.runId);
        else finished = result.run;
      }
    } catch (error) {
      if (this.current(mark)) { this.lost = requestId; this.update({ error: `${errorText(error)}. It is not known whether it ran. Reload to check before trying again.` }); }
    } finally {
      if (this.current(mark)) { this.update({ pending: false }); if (finished) await this.finished(finished); if (changed) await this.restage(changed.rows, changed.choices); }
    }
  }
  // Re-reads the review after a stale incoming Apply, keeping the choices whose rows read the same as before.
  private async restage(rows: ReadonlyMap<string, string>, choices: readonly SetupChoice[]) {
    await this.load(false);
    const review = this.state.review;
    if (!review) return;
    const fresh = new Map(review.rows.map(row => [row.itemId, seen(row)]));
    this.update({ choices: choices.filter(choice => rows.has(choice.itemId) && rows.get(choice.itemId) === fresh.get(choice.itemId)), previewError: PROFILE_CHANGED });
  }
  // Prepares a fresh preview of an interrupted run's change; a reconcile keeps only what is still waiting.
  async repreview() {
    const run = this.state.run;
    if (run?.state !== 'interrupted' || !this.state.eligibility.read) return;
    const change = run.intent.change;
    if (change.kind !== 'reconcile') return this.prepare(change);
    const waiting = new Set(applyKeys(this.state.inspection));
    const only = change.only.filter(key => waiting.has(key));
    if (!only.length) { this.update({ localError: 'Nothing from that run is still waiting to apply on this Mac.' }); return; }
    await this.prepare({ ...change, only });
  }
  // Opens the one confirmation Abandon needs; confirming calls abandon().
  askAbandon() { if (this.state.run?.state === 'interrupted' && this.state.eligibility.read) this.update({ confirmingAbandon: true }); }
  keepRun() { this.update({ confirmingAbandon: false }); }
  async abandon() { if (this.state.confirmingAbandon) await this.runAction('abandonRun'); }
  async cancel() { await this.runAction('cancelRun'); }
  private async runAction(name: 'abandonRun' | 'cancelRun') {
    const run = this.state.run;
    if (!run || this.state.pending || (name === 'abandonRun' ? run.state !== 'interrupted' || !this.state.eligibility.read : !this.state.eligibility.cancel)) return;
    const mark = this.mark(); this.runRead++; this.update({ pending: true, preview: null, previewNotice: null, switchTarget: null, error: null, confirmingAbandon: false });
    try {
      const result = await this.call(mark, name, { scope: SCOPE, runId: run.runId });
      if (result?.runId === run.runId) { this.runRead++; this.update({ run: result }); }
    } catch (error) { if (this.current(mark)) this.update({ error: errorText(error) }); }
    finally { if (this.current(mark)) this.update({ pending: false }); }
  }
  dispose() { this.disposed = true; this.epoch++; this.runRead++; this.unlisten(); this.unlistenEvents?.(); this.listeners.clear(); }
}
