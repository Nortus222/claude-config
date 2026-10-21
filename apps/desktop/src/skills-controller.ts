import type { ChangePreview, OperationOutput, RunView } from '@nortuscc/agent/operations';
import type { Bridge, Envelope, HostEvent } from './bridge.ts';
import type { MachineController, ViewState } from './controller.ts';
import { operation } from './operations.ts';
import { changeTitle, runCauses } from './copy.ts';
import { thisMachine } from './device.ts';

export type SkillChoice = 'on' | 'off' | 'inherit';
export type SkillRow = Extract<OperationOutput<'inspectIntent'>['items'][number], { kind: 'skill' }>;
export type SkillInventory = Omit<OperationOutput<'inspectIntent'>, 'items'> & { readonly items: readonly SkillRow[] };
export type SkillCheck = OperationOutput<'inspectUpdates'>;
export type SkillsViewState = {
  readonly native: boolean;
  readonly view: SkillInventory | null;
  readonly check: SkillCheck | null;
  readonly operation: 'load' | 'save' | 'check' | 'preview' | 'apply' | null;
  readonly saving: { readonly source: string; readonly name: string; readonly choice: SkillChoice } | null;
  readonly selected: readonly string[];
  readonly preview: ChangePreview | null;
  readonly run: RunView | null;
  readonly stale: string | null;
  // This Mac changed since Skills was read (another run, or a reconnect). An open page reads again as soon
  // as the Mac is free; until then choices wait, and a busy Mac shows `machine.busy` instead.
  readonly outdated: boolean;
  readonly error: string | null;
  readonly detail: string;
};
export type SkillsOptions = { readonly maintenance?: () => string | null };
const SCOPE = { kind: 'machine' } as const;
const PAGE_SIZE = 100;
const MAX_ERROR = 300;
const BROWSER = `Open the desktop app to manage skills on ${thisMachine}.`;
const text = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR);
const live = (run: RunView | null) => run?.state === 'accepted' || run?.state === 'running';
const sameSkill = (a: { source: string; name: string }, b: { source: string; name: string }) => a.source === b.source && a.name === b.name;
const label = { on: 'On', off: 'Off', inherit: 'Default' } as const;
// How a run that did not succeed ended, in words.
const ENDED: Partial<Readonly<Record<RunView['state'], string>>> = { failed: 'failed', cancelled: 'was cancelled', interrupted: 'was interrupted', abandoned: 'was abandoned' };
export const effectiveChoice = (row: SkillRow) => row.choice ?? row.defaultEnabled;

// Only checked, enabled declarations with an existing update route may be selected.
export function eligibleUpdates(view: { readonly items: readonly OperationOutput<'inspectIntent'>['items'][number][] } | null, check: SkillCheck | null): ReadonlySet<string> {
  if (!view || !check || check.unavailable) return new Set();
  return new Set(check.items.filter(update => (update.state === 'outdated' || update.state === 'off-pin') && update.repairRoute === 'reconcile'
    && view.items.some(row => row.kind === 'skill' && sameSkill(row, update) && effectiveChoice(row))).map(update => update.key));
}
export function mutationBlocked(machine: ViewState, skills: SkillsViewState, maintenance: string | null): string | null {
  if (!skills.native || machine.connection === 'browser') return BROWSER;
  if (machine.connection !== 'connected') return 'Reconnect the local agent to change skills.';
  if (live(skills.run) || machine.run?.outcome === 'running' || machine.status?.applying) return `An apply is running on ${thisMachine}. Wait for it to finish.`;
  if (machine.pending || machine.initialReadPending) return 'Another machine action is in progress.';
  if (maintenance) return maintenance;
  if (skills.operation) return 'A Skills request is in progress.';
  if (!skills.view) return 'Skills has not been read yet.';
  if (skills.outdated) return `Skills is reading ${thisMachine} again.`;
  return skills.stale;
}

// Skills owns its previews and receipts; status events can refresh only their matching run.
export class SkillsController {
  state: SkillsViewState;
  private listeners = new Set<() => void>();
  private disposed = false;
  private epoch = 0;
  private visit = 0;
  private active: Promise<void> | null = null;
  private refreshFlight: { dirty: boolean; promise: Promise<void> } | null = null;
  private unlistenMachine: () => void;
  private unlistenEvents?: () => void;
  private subscription: Promise<void>;
  private session: number;
  private connected: boolean;
  private settledRun: string | null = null;
  private pendingInventory = false;
  private visible = false;
  private catchingUp = false;
  private bridge: Bridge | null;
  private machine: MachineController;
  private maintenance: () => string | null;

  constructor(bridge: Bridge | null, machine: MachineController, options: SkillsOptions = {}) {
    this.bridge = bridge; this.machine = machine;
    this.maintenance = options.maintenance ?? (() => null);
    this.session = machine.state.session;
    this.connected = machine.state.connection === 'connected';
    this.state = { native: bridge !== null, view: null, check: null, operation: null, saving: null, selected: [], preview: null, run: null,
      stale: null, outdated: false, error: null, detail: bridge ? `Open Skills to read ${thisMachine}'s skills.` : BROWSER };
    this.unlistenMachine = machine.subscribe(() => {
      const connected = machine.state.connection === 'connected', reconnect = connected && !this.connected;
      this.connected = connected;
      if (machine.state.session !== this.session || !connected) {
        this.session = machine.state.session;
        this.epoch++;
        this.refreshFlight = null;
        this.update({ view: null, check: null, selected: [], preview: null, operation: null, saving: this.state.run ? this.state.saving : null, stale: null, outdated: true, error: null,
          detail: `Reconnect or reload Skills to read ${thisMachine}'s skills.` });
      }
      if (reconnect && this.state.run) void this.refreshRun();
      this.catchUp();
    });
    this.subscription = bridge ? bridge.subscribe(event => this.receive(event)).then(unlisten => {
      if (this.disposed) unlisten(); else this.unlistenEvents = unlisten;
    }).catch(error => { this.update({ error: `Could not watch Skills runs: ${text(error)}` }); }) : Promise.resolve();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  idle = async () => {
    while (this.active || this.refreshFlight) await Promise.all([this.active, this.refreshFlight?.promise]);
  };
  blocked = () => mutationBlocked(this.machine.state, this.state, this.maintenance());
  private update(fields: Partial<SkillsViewState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...fields };
    for (const listener of this.listeners) listener();
  }
  private current() {
    const epoch = this.epoch, token = this.machine.sessionToken();
    return (reply?: Envelope) => !this.disposed && epoch === this.epoch && this.machine.ownsSession(token, reply);
  }
  private ready() {
    return !this.disposed && this.bridge !== null && this.machine.state.connection === 'connected' && !this.machine.state.pending
      && !this.machine.state.initialReadPending && !live(this.state.run) && this.machine.state.run?.outcome !== 'running'
      && !this.machine.state.status?.applying && !this.state.operation;
  }
  private task(kind: NonNullable<SkillsViewState['operation']>, action: (current: ReturnType<SkillsController['current']>) => Promise<void>, fields: Partial<SkillsViewState> = {}) {
    this.epoch++;
    const current = this.current();
    this.update({ operation: kind, error: null, ...fields });
    const done = action(current).catch(error => { if (current()) this.update({ error: text(error), ...(fields.detail !== undefined && this.state.detail === fields.detail ? { detail: '' } : {}) }); }).finally(() => {
      if (this.active === done) this.active = null;
      if (current()) this.update({ operation: null, ...(!live(this.state.run) ? { saving: null } : {}) });
    });
    this.active = done;
    return done;
  }
  private receive(event: HostEvent) {
    if (!this.machine.ownsSession(this.machine.sessionToken(), { generation: event.generation, data: null })) return;
    if (event.event === 'operation-run' || event.event === 'status') {
      if (event.runId && event.runId === this.state.run?.runId) { void this.refreshRun(); return; }
      if (this.state.operation !== 'save' && this.state.operation !== 'apply' && !live(this.state.run)
        && (event.event === 'operation-run' || event.status.applying || event.runId)) {
        this.epoch++;
        this.update({ outdated: true, check: null, selected: [], preview: null, operation: null });
        this.catchUp();
      }
    }
  }
  // An open page whose read is out of date reads again once nothing else holds this Mac. It waits for the
  // other handlers of the same event, which may start an inspection that holds this Mac first.
  private catchUp() {
    if (this.catchingUp || !this.visible || !this.state.outdated) return;
    this.catchingUp = true;
    queueMicrotask(() => { this.catchingUp = false; if (this.visible && this.state.outdated && this.ready()) void this.reload(); });
  }
  enter() { this.visit++; this.visible = true; if (this.ready() && (!this.state.view || this.state.stale || this.state.outdated)) void this.reload(); }
  leave() { this.visit++; this.visible = false; }

  private async readInventory(current: ReturnType<SkillsController['current']>) {
    let cursor: string | undefined, generation: string | undefined;
    const items: SkillRow[] = [], cursors = new Set<string>();
    do {
      const reply = await operation(this.bridge!, 'inspectIntent', { scope: SCOPE, section: 'skills', limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      if (!current(reply)) return null;
      if (generation !== undefined && generation !== reply.data.generation) throw new Error('Skills changed while reading. Reload Skills to continue.');
      generation = reply.data.generation;
      items.push(...reply.data.items.filter((row): row is SkillRow => row.kind === 'skill'));
      if (!reply.data.nextCursor) return { ...reply.data, items };
      cursor = reply.data.nextCursor;
      if (cursors.has(cursor)) throw new Error('Skills pagination did not advance. Reload Skills.');
      cursors.add(cursor);
    } while (cursor);
    return null;
  }
  reload() {
    if (live(this.state.run) && !this.state.operation && this.machine.state.connection === 'connected') return this.refreshRun();
    if (!this.ready()) return this.idle();
    return this.task('load', async current => {
      const view = await this.readInventory(current);
      if (view) {
        this.pendingInventory = false;
        this.update({ view, check: null, selected: [], preview: null, stale: null, outdated: false, detail: `Skills read from ${thisMachine}.` });
      }
    }, { detail: `Reading skills on ${thisMachine}`, outdated: false });
  }
  setChoice(source: string, name: string, choice: SkillChoice) {
    if (!this.ready() || this.blocked()) return Promise.resolve();
    const row = this.state.view!.items.find(row => sameSkill(row, { source, name }));
    if (!row || (row.choice === null ? 'inherit' : row.choice ? 'on' : 'off') === choice) return Promise.resolve();
    const change = { kind: 'machineIntent', patch: { kind: 'skill', source, name, action: choice === 'inherit' ? 'reset' : choice === 'on' ? 'enable' : 'disable' } } as const;
    return this.task('save', async current => {
      const reply = await operation(this.bridge!, 'previewChange', { scope: SCOPE, change });
      if (!current(reply)) return;
      await this.submit(reply.data, current);
    }, { saving: { source, name, choice }, check: null, selected: [], preview: null, detail: `Saving the choice for ${name}` });
  }
  private async submit(preview: ChangePreview, current: ReturnType<SkillsController['current']>) {
    await this.subscription;
    try {
      const reply = await operation(this.bridge!, 'applyChange', { scope: SCOPE, planId: preview.planId, requestId: crypto.randomUUID() });
      if (!current(reply)) return;
      if (reply.data.status === 'stale') {
        this.update({ preview: reply.data.preview, saving: null, detail: 'The machine changed since this preview. Review the new plan and apply again.' });
        return;
      }
      this.settledRun = null;
      this.pendingInventory = false;
      this.refreshFlight = null;
      this.update({ run: reply.data.run, preview: null });
      await this.refreshRun();
    } catch (error) {
      if (current()) this.update({ stale: 'Could not confirm whether the change was saved. Reload Skills to read the saved choice.', check: null, selected: [], preview: null, saving: null, error: text(error), detail: '' });
    }
  }
  private refreshRun() {
    if (!this.bridge || !this.state.run) return Promise.resolve();
    if (this.refreshFlight) { this.refreshFlight.dirty = true; return this.refreshFlight.promise; }
    const current = this.current(), runId = this.state.run.runId;
    const flight = { dirty: false, promise: Promise.resolve() };
    flight.promise = (async () => {
      do {
        flight.dirty = false;
        const reply = await operation(this.bridge!, 'getRun', { scope: SCOPE, runId });
        if (!current(reply) || reply.data.runId !== runId || this.state.run?.runId !== runId) return;
        this.update({ run: reply.data });
        if (live(reply.data)) continue;
        if (reply.data.state !== 'succeeded') {
          const ended = `${changeTitle(reply.data.intent.change.kind)} ${ENDED[reply.data.state] ?? 'stopped'}.`, [cause] = runCauses(reply.data);
          this.update({ saving: null, stale: `${ended}${cause ? ` ${cause}` : ''} Reload Skills to see the saved choice and what is on ${thisMachine}.`, check: null, selected: [], detail: ended });
        } else if (this.settledRun !== runId || this.pendingInventory) {
          const firstConfirmation = this.settledRun !== runId;
          this.settledRun = runId;
          const saving = this.state.saving;
          const detail = !firstConfirmation ? this.state.detail : saving ? `Saved ${saving.name}: ${label[saving.choice]}. Apply on Changes makes installation changes.` : 'Skill update succeeded. Reload Skills to see what is installed.';
          this.pendingInventory = true;
          this.update({ saving: null, check: null, selected: [], detail });
          try {
            const view = await this.readInventory(current);
            if (view) { this.pendingInventory = false; this.update({ view, stale: null, error: null }); }
          } catch (error) {
            if (current()) this.update({ stale: 'The run succeeded. Reload Skills to read current choices and installation state.', error: text(error) });
          }
        }
      } while (flight.dirty && current());
    })().catch(error => {
      if (current() && this.state.run?.runId === runId) this.update({ error: `Could not read the Skills run: ${text(error)}`, detail: 'It is not known whether the change finished. Reload Skills to see where it stands, or reconnect the agent in Settings.' });
    }).finally(() => { if (this.refreshFlight === flight) this.refreshFlight = null; });
    this.refreshFlight = flight;
    return flight.promise;
  }
  check() {
    if (!this.ready() || this.blocked()) return this.idle();
    return this.task('check', async current => {
      let cursor: string | undefined, generation: string | undefined;
      const items: SkillCheck['items'][number][] = [], cursors = new Set<string>();
      do {
        const reply = await operation(this.bridge!, 'inspectUpdates', { scope: SCOPE, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
        if (!current(reply)) return;
        if (generation !== undefined && generation !== reply.data.generation) throw new Error('The upstream check changed. Check upstream again.');
        generation = reply.data.generation;
        items.push(...reply.data.items);
        if (!reply.data.nextCursor || reply.data.unavailable) {
          this.update({ check: { ...reply.data, items }, detail: reply.data.unavailable ? 'Upstream checks are unavailable.' : 'Upstream checked. Preview selected updates before applying.' });
          return;
        }
        cursor = reply.data.nextCursor;
        if (cursors.has(cursor)) throw new Error('The upstream check pagination did not advance. Check upstream again.');
        cursors.add(cursor);
      } while (cursor);
    }, { check: null, selected: [], preview: null, detail: 'Checking upstream sources. Nothing installs until you preview and apply.' });
  }
  toggle(key: string) {
    if (this.blocked() || !eligibleUpdates(this.state.view, this.state.check).has(key)) return;
    this.update({ selected: this.state.selected.includes(key) ? this.state.selected.filter(k => k !== key) : [...this.state.selected, key], preview: null });
  }
  previewUpdate() {
    if (!this.ready() || this.blocked()) return Promise.resolve();
    const eligible = eligibleUpdates(this.state.view, this.state.check), only = this.state.selected.filter(key => eligible.has(key));
    if (!only.length) return Promise.resolve();
    const targets = [...new Set(this.state.check!.items.filter(item => only.includes(item.key)).flatMap(item => item.targets))];
    const visit = this.visit;
    return this.task('preview', async current => {
      const reply = await operation(this.bridge!, 'previewChange', { scope: SCOPE, change: { kind: 'update', only, targets, authorManifest: false } });
      if (current(reply) && visit === this.visit) this.update({ preview: reply.data, detail: 'Update preview ready. Apply update runs only the previewed steps.' });
    }, { preview: null, detail: 'Planning the selected updates' });
  }
  applyUpdate() {
    const preview = this.state.preview;
    if (!this.ready() || this.blocked() || preview?.change.kind !== 'update') return Promise.resolve();
    return this.task('apply', current => this.submit(preview, current), { detail: 'Starting the skill update' });
  }
  async cancel() {
    if (!this.bridge || !live(this.state.run)) return;
    const current = this.current();
    try {
      const reply = await operation(this.bridge, 'cancelRun', { scope: SCOPE, runId: this.state.run!.runId });
      if (current(reply)) await this.refreshRun();
    } catch (error) { if (current()) this.update({ error: text(error) }); }
  }
  dispose() {
    this.disposed = true; this.epoch++; this.unlistenMachine(); this.unlistenEvents?.(); this.listeners.clear();
  }
}
