import type { ChangePreview, OperationChange, OperationInput, OperationName, OperationOutput, RunView } from '@nortuscc/agent/operations';
import type { Bridge, HostEvent } from './bridge.ts';
import type { MachineController } from './controller.ts';
import { operation } from './operations.ts';

export type AuthorIntent = Extract<OperationChange, { kind: 'editDraft' }>['intent'];
type DraftEntry = OperationOutput<'drafts'>['drafts'][number];
type Draft = Extract<DraftEntry, { intents: unknown }>;
type CaptureChoice = Extract<AuthorIntent, { kind: 'captureFile' }>['choice'];
export type AuthorState = {
  profiles: OperationOutput<'authorProfiles'> | null; upstreams: OperationOutput<'upstreams'> | null;
  selectedProfile: string; file: OperationOutput<'authorFile'> | null; fileId: string | null;
  capture: { profile: string; fileId: string; text: string; affectedProfiles: readonly string[] } | null;
  drafts: readonly DraftEntry[]; draft: Draft | null; draftPreview: OperationOutput<'draftPreview'> | null;
  preview: ChangePreview | null; run: RunView | null; publicationRun: RunView | null; gh: OperationOutput<'ghState'> | null;
  skill: OperationOutput<'upstreamSkill'> | null; pending: boolean; canRead: boolean; canWrite: boolean; canPublish: boolean;
  error: string | null; errorCode: string | null; message: string;
};
const SCOPE = { kind: 'machine' } as const;
const RUN_LIMIT = 100;
const active = (run: RunView | null) => run?.state === 'accepted' || run?.state === 'running';
const publication = (run: RunView) => run.intent.change.kind === 'publishDraft' || run.intent.change.kind === 'announcePublication';
const author = (run: RunView) => publication(run) || ['editDraft', 'removeDraftIntent', 'deleteDraft', 'ghLogin'].includes(run.intent.change.kind);

// Draft plans belong to one agent session. Only matching durable receipts confirm writes or publication.
export class AuthorController {
  state: AuthorState = { profiles: null, upstreams: null, selectedProfile: '', file: null, fileId: null, capture: null, drafts: [], draft: null,
    draftPreview: null, preview: null, run: null, publicationRun: null, gh: null, skill: null, pending: false, canRead: false, canWrite: false,
    canPublish: false, error: null, errorCode: null, message: '' };
  private listeners = new Set<() => void>();
  private disposed = false;
  private visible = false;
  private epoch = 0;
  private discovery = 0;
  private reads = new Map<string, number>();
  private settled = new Set<string>();
  private settling = new Set<string>();
  private unlisten: () => void;
  private unlistenEvents?: () => void;
  private inMaintenance = false;
  private uncertain = false;
  private maintenance: () => boolean;
  constructor(private bridge: Bridge | null, private machine: MachineController, options: { maintenance?: () => boolean } = {}) {
    this.maintenance = options.maintenance ?? (() => false);
    let session = machine.state.session, connection = machine.state.connection;
    this.unlisten = machine.subscribe(() => {
      const changed = session !== machine.state.session || connection !== machine.state.connection;
      session = machine.state.session; connection = machine.state.connection;
      if (changed) {
        this.invalidate();
        this.update({ profiles: null, upstreams: null, file: null, capture: null, gh: null, skill: null });
        if (connection === 'connected') {
          if (this.state.run) void this.readRun(this.state.run.runId);
          if (this.state.publicationRun && this.state.publicationRun.runId !== this.state.run?.runId) void this.readRun(this.state.publicationRun.runId);
          if (this.visible) void this.reload();
        }
      } else this.update({});
    });
    if (bridge) void bridge.subscribe(event => this.receive(event)).then(off => { if (this.disposed) off(); else this.unlistenEvents = off; })
      .catch(error => this.fail(error));
    this.update({});
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(patch: Partial<AuthorState>) {
    if (this.disposed) return;
    const state = { ...this.state, ...patch };
    const connected = !!this.bridge && this.machine.state.connection === 'connected';
    const canRead = connected && !this.maintenance() && !state.pending;
    const canWrite = canRead && !this.settling.size && !this.uncertain && !this.machine.state.pending && !this.machine.state.initialReadPending && !this.machine.state.status?.applying
      && this.machine.state.run?.outcome !== 'running' && !active(state.run) && !active(state.publicationRun);
    this.state = { ...state, canRead, canWrite, canPublish: canWrite && state.gh?.state === 'ready'
      && !!state.draft?.intents.length && !!state.draftPreview && state.draftPreview.invalid.length === 0 && state.preview?.change.kind === 'publishDraft' };
    for (const listener of this.listeners) listener();
  }
  private mark() { return { epoch: this.epoch, token: this.machine.sessionToken() }; }
  private current(mark: ReturnType<AuthorController['mark']>) { return !this.disposed && mark.epoch === this.epoch && this.machine.ownsSession(mark.token); }
  private async call<N extends OperationName>(mark: ReturnType<AuthorController['mark']>, name: N, input: OperationInput<N>): Promise<OperationOutput<N> | undefined> {
    if (!this.current(mark)) return undefined;
    const reply = await operation(this.bridge!, name, input);
    return this.current(mark) && this.machine.ownsSession(mark.token, reply) ? reply.data : undefined;
  }
  private fail(error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : null;
    this.update({ error: text, errorCode: ['NOT_SIGNED_IN', 'APP_UNAVAILABLE', 'UNAUTHORIZED'].find(c => c === code || text.includes(c)) ?? null });
  }
  private invalidate() { this.epoch++; this.discovery++; this.reads.clear(); this.settling.clear(); this.update({ preview: null, draftPreview: null, pending: false, capture: null, file: null }); }
  refresh() {
    const maintenance = this.maintenance();
    if (maintenance && !this.inMaintenance) this.invalidate();
    this.inMaintenance = maintenance; this.update({});
  }
  enter() { this.visible = true; if (!this.state.profiles) void this.reload(); else void this.discoverRuns(); }
  leave() { this.visible = false; }
  private async request(body: (mark: ReturnType<AuthorController['mark']>) => Promise<void>, write = false) {
    if (this.disposed || !(write ? this.state.canWrite : this.state.canRead)) return;
    if (write) this.discovery++;
    const mark = this.mark(); this.update({ pending: true, error: null, errorCode: null });
    try { await body(mark); } catch (error) { if (this.current(mark)) this.fail(error); }
    finally { if (this.current(mark)) this.update({ pending: false }); }
  }
  async reload() {
    await this.request(async mark => {
      this.update({ preview: null, draftPreview: null, capture: null, file: null, skill: null });
      await this.loadData(mark);
    });
    if (!this.disposed && this.machine.state.connection === 'connected') await this.discoverRuns();
  }
  private async loadData(mark: ReturnType<AuthorController['mark']>) {
    // Read independently so a repository access failure does not hide drafts or GitHub sign-in.
    const preferred = this.state.draft?.id;
    await Promise.allSettled([
      this.call(mark, 'authorProfiles', { scope: SCOPE }).then(profiles => { if (profiles) this.update({ profiles, selectedProfile: profiles.profiles.some(p => p.name === this.state.selectedProfile) ? this.state.selectedProfile : profiles.profiles[0]?.name ?? '' }); }),
      this.call(mark, 'upstreams', { scope: SCOPE }).then(upstreams => { if (upstreams) this.update({ upstreams }); }),
      this.loadDrafts(mark),
      this.call(mark, 'ghState', { scope: SCOPE }).then(gh => { if (gh) this.update({ gh }); }),
    ].map(promise => promise.catch(error => { if (this.current(mark)) this.fail(error); })));
    if (this.current(mark)) this.chooseOwnedDraft(this.state.drafts, preferred);
  }
  private async loadDrafts(mark: ReturnType<AuthorController['mark']>, preferred = this.state.draft?.id) {
    const result = await this.call(mark, 'drafts', { scope: SCOPE });
    if (!result) return;
    this.chooseOwnedDraft(result.drafts, preferred);
  }
  private chooseOwnedDraft(drafts: readonly DraftEntry[], preferred?: string) {
    const valid = drafts.filter((entry): entry is Draft => 'intents' in entry && entry.repoUrl === this.state.profiles?.repoUrl);
    this.update({ drafts, draft: valid.find(d => d.id === preferred) ?? valid[0] ?? null });
  }
  async selectProfile(name: string) {
    if (!this.state.canRead || !this.state.profiles?.profiles.some(p => p.name === name)) return;
    this.update({ selectedProfile: name, file: null, fileId: null, capture: null });
  }
  async selectFile(fileId: string) {
    const profile = this.state.selectedProfile;
    await this.request(async mark => {
      this.update({ file: null, fileId, capture: null });
      const file = await this.call(mark, 'authorFile', { scope: SCOPE, profile, fileId });
      if (file) this.update({ file });
    });
  }
  async captureFile(fileId: string) {
    const profile = this.state.selectedProfile;
    await this.request(async mark => {
      this.update({ capture: null });
      const file = await this.call(mark, 'machineFile', { scope: SCOPE, fileId, profile });
      if (!file) return;
      if (!file.exists) throw new Error('This file is absent on this Mac. Nothing was captured.');
      if (file.truncated) throw new Error('This file exceeds the capture size limit. Partial text cannot be captured.');
      const path = this.state.profiles?.profiles.find(p => p.name === profile)?.files.find(f => f.fileId === fileId)?.path;
      const affectedProfiles = path ? this.state.profiles!.profiles.filter(p => p.files.some(f => f.path === path)).map(p => p.name) : [profile];
      this.update({ capture: { profile, fileId, text: file.text, affectedProfiles } });
    }, true);
  }
  async saveCapture(choice: CaptureChoice) {
    const capture = this.state.capture; if (!capture) return;
    await this.addIntent({ kind: 'captureFile', profile: capture.profile, fileId: capture.fileId, text: capture.text, choice });
    if (this.state.run?.state === 'succeeded' && !this.state.error) this.update({ capture: null });
  }
  async includeSkill(profile: string, source: string, name: string, include: boolean) {
    await this.addIntent({ kind: include ? 'includeSkill' : 'excludeSkill', profile, source, name });
  }
  async pin(source: string, commit: string) { await this.addIntent({ kind: 'pin', source, commit }); }
  async unpin(source: string) { await this.addIntent({ kind: 'unpin', source }); }
  private async addIntent(intent: AuthorIntent) { await this.change({ kind: 'editDraft', draftId: this.state.draft?.id ?? null, intent }); }
  async removeIntent(index: number) { if (this.state.draft) await this.change({ kind: 'removeDraftIntent', draftId: this.state.draft.id, index }); }
  async deleteDraft(id = this.state.draft?.id) { if (id) await this.change({ kind: 'deleteDraft', draftId: id }); }
  selectDraft(id: string) {
    if (!this.state.canWrite) return;
    const draft = this.state.drafts.find(d => d.id === id && 'intents' in d);
    if (draft && 'intents' in draft) this.update({ draft, preview: null, draftPreview: null });
  }
  newDraft() { if (this.state.canWrite) this.update({ draft: null, preview: null, draftPreview: null }); }
  async discover(source: string) {
    await this.request(async mark => {
      const discovery = await this.call(mark, 'discoverUpstream', { scope: SCOPE, source });
      if (!discovery) return;
      const upstreams = await this.call(mark, 'upstreams', { scope: SCOPE }); if (upstreams) this.update({ upstreams, skill: null });
    }, true);
  }
  async readSkill(source: string, commit: string, name: string) {
    await this.request(async mark => { this.update({ skill: null }); const skill = await this.call(mark, 'upstreamSkill', { scope: SCOPE, source, commit, name }); if (skill) this.update({ skill }); });
  }
  async previewDraft() {
    const draft = this.state.draft; if (!draft) return;
    await this.request(async mark => {
      this.update({ preview: null, draftPreview: null });
      const draftPreview = await this.call(mark, 'draftPreview', { scope: SCOPE, draftId: draft.id });
      if (!draftPreview) return;
      this.update({ draftPreview });
      if (!draftPreview.invalid.length) {
        const preview = await this.call(mark, 'previewChange', { scope: SCOPE, change: { kind: 'publishDraft', draftId: draft.id, digest: draftPreview.digest } });
        if (preview) this.update({ preview });
      }
    }, true);
  }
  async publish() {
    if (!this.state.canPublish || !this.state.preview) return;
    const preview = this.state.preview;
    await this.request(mark => this.apply(mark, preview), true);
  }
  async repreview() {
    const run = this.state.run;
    if (!run || run.state !== 'interrupted') return;
    if (publication(run)) { await this.previewDraft(); return; }
    await this.request(async mark => {
      this.update({ preview: null, draftPreview: null });
      const preview = await this.call(mark, 'previewChange', { scope: SCOPE, change: run.intent.change });
      if (preview) this.update({ preview, ...('draft' in preview ? { draftPreview: preview.draft } : {}) });
    }, true);
  }
  async applyReviewed() {
    const preview = this.state.preview;
    if (preview && !['publishDraft', 'announcePublication'].includes(preview.change.kind))
      await this.request(mark => this.apply(mark, preview), true);
  }
  async signIn() { await this.change({ kind: 'ghLogin' }); }
  async announce() {
    const run = this.state.publicationRun;
    if (run && (run.publicationRecovery?.action === 'announce' || run.publication?.pushed && (run.publication.pending.length > 0 || !run.publication.tagged)))
      await this.change({ kind: 'announcePublication', runId: run.runId });
  }
  async recheck() { if (this.state.canRead && this.state.publicationRun) await this.readRun(this.state.publicationRun.runId); }
  private async change(change: OperationChange) {
    await this.request(async mark => {
      this.update({ preview: null, draftPreview: null }); this.discovery++;
      const preview = await this.call(mark, 'previewChange', { scope: SCOPE, change });
      if (preview) await this.apply(mark, preview);
    }, true);
  }
  private async apply(mark: ReturnType<AuthorController['mark']>, preview: ChangePreview) {
    this.update({ preview: null, message: 'Waiting for the agent to confirm the action.' });
    let result: OperationOutput<'applyChange'> | undefined;
    try { result = await this.call(mark, 'applyChange', { scope: SCOPE, planId: preview.planId, requestId: crypto.randomUUID() }); }
    catch (error) {
      if (this.current(mark)) {
        this.uncertain = true;
        this.fail(error);
        this.update({ error: `${this.state.error}. Completion is unconfirmed. Reload to inspect runs before another action.` });
      }
      return;
    }
    if (!result) return;
    if (result.status === 'stale') { this.update({ message: 'Needs preview. Preview the draft again before publishing.' }); return; }
    this.reads.clear();
    this.update({ run: result.run, ...(publication(result.run) ? { publicationRun: result.run } : {}) });
    await this.readRun(result.run.runId);
  }
  private async readRun(runId: string) {
    if (this.disposed || !this.bridge || this.machine.state.connection !== 'connected') return;
    const serial = (this.reads.get(runId) ?? 0) + 1; this.reads.set(runId, serial); const mark = this.mark();
    try {
      const run = await this.call(mark, 'getRun', { scope: SCOPE, runId });
      if (!run || run.runId !== runId || this.reads.get(runId) !== serial) return;
      if (this.state.run?.runId !== runId && this.state.publicationRun?.runId !== runId) return;
      this.update({ ...(this.state.run?.runId === runId ? { run } : {}), ...(publication(run) ? { publicationRun: run } : {}), message: `Action ${run.state}` });
      if (!active(run) && !this.settled.has(runId) && !this.settling.has(runId)) {
        this.settling.add(runId); this.update({ preview: null, draftPreview: null });
        try {
          const acceptance = run.intent.parity;
          await this.loadDrafts(mark, acceptance && 'draftId' in acceptance ? acceptance.draftId ?? undefined : undefined);
          if (publication(run)) {
            const profiles = await this.call(mark, 'authorProfiles', { scope: SCOPE });
            if (profiles) this.update({ profiles });
          }
          const gh = await this.call(mark, 'ghState', { scope: SCOPE });
          if (gh) { this.settled.add(runId); this.update({ gh }); }
        } finally {
          if (this.current(mark)) { this.settling.delete(runId); this.update({}); }
        }
      }
    } catch (error) { if (this.current(mark) && this.reads.get(runId) === serial) this.fail(error); }
  }
  private async discoverRuns() {
    if (this.disposed || !this.bridge || this.machine.state.connection !== 'connected' || active(this.state.run) || this.state.pending) return;
    const mark = this.mark(), serial = ++this.discovery;
    try {
      const result = await this.call(mark, 'listRuns', { scope: SCOPE, limit: RUN_LIMIT });
      if (!result || serial !== this.discovery) return;
      this.uncertain = false;
      const run = result.runs.find(author), published = result.runs.find(publication);
      this.update({ ...(run ? { run } : {}), ...(published ? { publicationRun: published } : {}) });
      if (run) await this.readRun(run.runId);
      if (published && published.runId !== run?.runId) await this.readRun(published.runId);
    } catch (error) { if (this.current(mark)) this.fail(error); }
  }
  private receive(event: HostEvent) {
    if (!this.machine.ownsSession(this.machine.sessionToken(), { generation: event.generation, data: null })) return;
    if (event.event === 'operation-run' || event.event === 'status' || event.event === 'progress') {
      if (event.runId && (event.runId === this.state.run?.runId || event.runId === this.state.publicationRun?.runId)) void this.readRun(event.runId);
      else if (event.event === 'operation-run' && !this.state.run && this.visible && !this.state.pending) void this.discoverRuns();
    }
  }
  async abandon() {
    const run = this.state.run; if (!run || run.state !== 'interrupted') return;
    await this.request(async mark => {
      this.reads.set(run.runId, (this.reads.get(run.runId) ?? 0) + 1);
      const receipt = await this.call(mark, 'abandonRun', { scope: SCOPE, runId: run.runId });
      if (receipt) { this.reads.set(run.runId, (this.reads.get(run.runId) ?? 0) + 1); this.update({ run: receipt, ...(publication(receipt) ? { publicationRun: receipt } : {}), preview: null }); }
    }, true);
  }
  async cancel() {
    const run = this.state.run; if (!active(run) || !run) return;
    await this.request(async mark => {
      const receipt = await this.call(mark, 'cancelRun', { scope: SCOPE, runId: run.runId });
      if (receipt) { this.reads.set(run.runId, (this.reads.get(run.runId) ?? 0) + 1); this.update({ run: receipt, ...(publication(receipt) ? { publicationRun: receipt } : {}) }); }
    });
  }
  dispose() { this.disposed = true; this.epoch++; this.unlisten(); this.unlistenEvents?.(); this.listeners.clear(); }
}
