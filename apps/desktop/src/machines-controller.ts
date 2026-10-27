import type { OperationOutput, RunView } from '@nortuscc/agent/operations';
import type { Bridge, Envelope } from './bridge.ts';
import type { MachineController } from './controller.ts';
import { operation } from './operations.ts';
import { MACHINES_WORDS, cellFailed, errorText, keptNotice, offlineNotice, runCauses } from './copy.ts';
import { ThisMachine } from './device.ts';

// `this` or a Tailscale node ID, as the agent's fan-out operations take it.
export type MachineRef = string;
export type RemoteAccess = OperationOutput<'remoteAccess'>;
export type MachineSkill = OperationOutput<'machineSkills'>['skills'][number];
export type Reach = OperationOutput<'myMachines'>['machines'][number]['reach'];
export type Column = {
  readonly ref: MachineRef; readonly name: string; readonly os: string; readonly self: boolean; readonly reach: Reach; readonly lastReachedAt: string | null;
  // What the machine last reported, and when it inspected; null until first read. A failed read keeps them and sets `error`;
  // `busy` says the machine was running a change, so a refresh showed its last check.
  readonly inspectedAt: string | null; readonly skills: readonly MachineSkill[] | null; readonly loading: boolean; readonly error: string | null; readonly busy: boolean;
};
export type NotSetUp = OperationOutput<'myMachines'>['notSetUp'][number];
export type CellChange = 'working' | { readonly failed: string };
export type Cell = 'installed' | 'absent' | 'undeclared' | 'profile' | 'working' | { readonly failed: string } | 'offline';
export type SkillId = { readonly source: string | null; readonly name: string };
export type GridRow = SkillId & { readonly cells: Readonly<Record<MachineRef, Cell>> };
export type MachinesViewState = {
  readonly native: boolean;
  readonly access: RemoteAccess | null;
  readonly columns: readonly Column[];
  // The user's machines on Tailscale whose app has never answered.
  readonly notSetUp: readonly NotSetUp[];
  // Cells being changed or whose change did not land, by machine and `rowKey`.
  readonly changes: Readonly<Record<MachineRef, Readonly<Record<string, CellChange>>>>;
  // What the last action reported beyond its cells.
  readonly notices: readonly string[];
  readonly loading: boolean;
  readonly switching: boolean;
  readonly error: string | null;
};
export type MachinesOptions = { readonly pollMs?: number; readonly now?: () => number };
type Current = (reply?: Envelope) => boolean;
type Action = 'install' | 'remove';

const SCOPE = { kind: 'machine' } as const;
const live = (run: RunView) => run.state === 'accepted' || run.state === 'running';
const CELL: Readonly<Record<MachineSkill['state'], Cell>> = { installed: 'installed', absent: 'absent', undeclared: 'undeclared', 'profile-off': 'profile' };
export const rowKey = (skill: SkillId) => JSON.stringify([skill.source, skill.name]);
// A page entered again re-reads once its last read is older than this.
const STALE_MS = 60_000;
// Reads after a run until the machine reports a check newer than the one before the change.
const SETTLE_READS = 5;
const newer = (at: string | null, than: string | null) => at !== null && (than === null || Date.parse(at) > Date.parse(than));
const REVISION = /^[0-9a-f]{40}$/;
// Why an install revision can't be used, or null; empty means the latest version.
export const revisionError = (revision: string) => { const text = revision.trim(); return !text || REVISION.test(text) ? null : MACHINES_WORDS.revisionInvalid; };
// Changes without the failures shown, keeping cells still being changed.
const withoutFailures = (changes: MachinesViewState['changes']) =>
  Object.fromEntries(Object.entries(changes).map(([ref, cells]) => [ref, Object.fromEntries(Object.entries(cells).filter(([, change]) => change === 'working'))]));

// The grid input for each machine: what it reported (null when it can't be read) and the cells being changed.
export const perMachine = (state: Pick<MachinesViewState, 'columns' | 'changes'>) => Object.fromEntries(state.columns.map(column =>
  [column.ref, { skills: column.reach === 'ok' ? column.skills : null, changes: state.changes[column.ref] ?? {} }]));

// One row per skill identity across machines, sorted by name; a cell shows its change over what the machine reported.
export function gridRows(machines: Readonly<Record<MachineRef, { readonly skills: readonly MachineSkill[] | null; readonly changes?: Readonly<Record<string, CellChange>> }>>): GridRow[] {
  const ids = new Map<string, SkillId>();
  for (const { skills } of Object.values(machines)) for (const skill of skills ?? []) ids.set(rowKey(skill), { source: skill.source, name: skill.name });
  return [...ids].sort(([, a], [, b]) => a.name.localeCompare(b.name) || (a.source ?? '').localeCompare(b.source ?? ''))
    .map(([key, id]) => ({ ...id, cells: Object.fromEntries(Object.entries(machines).map(([ref, { skills, changes }]): [string, Cell] => {
      if (!skills) return [ref, 'offline'];
      const change = changes?.[key];
      if (change) return [ref, change];
      const reported = skills.find(skill => rowKey(skill) === key);
      return [ref, reported ? CELL[reported.state] : 'absent'];
    })) }));
}

// Skills on the user's machines: reads every reachable machine and installs or removes a skill on any of them,
// following each target's run until it finishes. Nothing is sent to a machine that can't be reached.
export class MachinesController {
  state: MachinesViewState;
  private listeners = new Set<() => void>();
  private disposed = false;
  private epoch = 0;
  // Set by the first read, so a session change knows there is something to clear.
  private touched = false;
  private loadedAt: number | null = null;
  // Each machine-list read; a newer one supersedes an older one still in flight.
  private reads = 0;
  private reading: Promise<void> | null = null;
  private flights = new Set<Promise<unknown>>();
  // The latest change sent to each machine; the next one there waits for it, since a machine runs one change at a time.
  private queues = new Map<MachineRef, Promise<unknown>>();
  private waits = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
  private session: number;
  private unlistenMachine: () => void;
  private bridge: Bridge | null;
  private machine: MachineController;
  private pollMs: number;
  private now: () => number;

  constructor(bridge: Bridge | null, machine: MachineController, options: MachinesOptions = {}) {
    this.bridge = bridge; this.machine = machine; this.pollMs = options.pollMs ?? 1000; this.now = options.now ?? Date.now;
    this.session = machine.state.session;
    this.state = { native: bridge !== null, access: null, columns: [], notSetUp: [], changes: {}, notices: [], loading: false, switching: false, error: null };
    this.unlistenMachine = machine.subscribe(() => {
      if (machine.state.session === this.session && machine.state.connection === 'connected') return;
      this.session = machine.state.session;
      if (!this.touched) return;
      this.epoch++; this.touched = false; this.loadedAt = null; this.reading = null; this.queues.clear(); this.stopWaits();
      this.update({ access: null, columns: [], notSetUp: [], changes: {}, notices: [], loading: false, switching: false, error: null });
    });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  idle = async () => { while (this.flights.size) await Promise.all(this.flights); };
  private update(fields: Partial<MachinesViewState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...fields };
    for (const listener of this.listeners) listener();
  }
  private current(): Current {
    const epoch = this.epoch, token = this.machine.sessionToken();
    return (reply?: Envelope) => !this.disposed && epoch === this.epoch && this.machine.ownsSession(token, reply);
  }
  private ready() { return !this.disposed && this.bridge !== null && this.machine.state.connection === 'connected'; }
  private track<T>(promise: Promise<T>) {
    this.flights.add(promise);
    void promise.finally(() => this.flights.delete(promise)).catch(() => {});
    return promise;
  }
  private wait() {
    return new Promise<void>(resolve => {
      const entry = { resolve, timer: setTimeout(() => { this.waits.delete(entry); resolve(); }, this.pollMs) };
      this.waits.add(entry);
    });
  }
  private stopWaits() { for (const entry of this.waits) { clearTimeout(entry.timer); entry.resolve(); } this.waits.clear(); }
  private column(ref: MachineRef) { return this.state.columns.find(column => column.ref === ref); }
  private patchColumn(ref: MachineRef, fields: Partial<Column>) {
    this.update({ columns: this.state.columns.map(column => column.ref === ref ? { ...column, ...fields } : column) });
  }
  private setChange(ref: MachineRef, skill: SkillId, change: CellChange | null) {
    const { [rowKey(skill)]: _, ...rest } = this.state.changes[ref] ?? {};
    this.update({ changes: { ...this.state.changes, [ref]: change ? { ...rest, [rowKey(skill)]: change } : rest } });
  }

  enter() {
    if (this.ready() && !this.reading && (this.loadedAt === null || this.now() - this.loadedAt > STALE_MS)) void this.load(false);
  }
  leave() {}

  // Reads remote access and the machine list, then each reachable machine's skills in parallel. `fresh` asks
  // every machine to inspect again and clears the failures shown.
  private load(fresh: boolean) {
    this.touched = true;
    const read = ++this.reads, session = this.current();
    const current: Current = reply => session(reply) && read === this.reads;
    this.update({ loading: true, error: null, notices: [], ...(fresh ? { changes: withoutFailures(this.state.changes) } : {}) });
    const reading: Promise<void> = this.track((async () => {
      const [access, mine] = await Promise.all([operation(this.bridge!, 'remoteAccess', { scope: SCOPE }), operation(this.bridge!, 'myMachines', { scope: SCOPE })]);
      if (!current(access) || !current(mine)) return;
      const previous = (ref: MachineRef) => this.column(ref) ?? { inspectedAt: null, skills: null, busy: false };
      const self = mine.data.self;
      const columns: Column[] = [{ ref: 'this', name: self?.name ?? ThisMachine, os: self?.os ?? '', self: true, reach: 'ok' as Reach, lastReachedAt: null as string | null },
        ...mine.data.machines.map(peer => ({ ref: peer.nodeId, name: peer.name, os: peer.os, self: false, reach: peer.reach, lastReachedAt: peer.lastReachedAt }))]
        .map(column => ({ ...column, inspectedAt: previous(column.ref).inspectedAt, skills: previous(column.ref).skills, busy: previous(column.ref).busy, loading: column.reach === 'ok', error: null }));
      this.update({ access: access.data, columns, notSetUp: mine.data.notSetUp });
      await Promise.all(columns.filter(column => column.reach === 'ok').map(column => this.readSkills(column.ref, fresh, current)));
      if (current()) this.loadedAt = this.now();
    })().catch(error => { if (current()) this.update({ error: errorText(error) }); }).finally(() => {
      if (current()) this.update({ loading: false });
      if (this.reading === reading) this.reading = null;
    }));
    this.reading = reading;
    return reading;
  }
  // Reads one machine's skills; resolves with when it inspected, or null when the read failed and the column kept what it had.
  private async readSkills(ref: MachineRef, fresh: boolean, current: Current): Promise<string | null> {
    this.patchColumn(ref, { loading: true, error: null });
    try {
      const reply = await operation(this.bridge!, 'machineSkills', { scope: SCOPE, machine: ref, ...(fresh ? { fresh: true } : {}) });
      if (!current(reply)) return null;
      this.patchColumn(ref, { loading: false, skills: reply.data.skills, inspectedAt: reply.data.inspectedAt, busy: reply.data.busy === true });
      return reply.data.inspectedAt;
    } catch (error) {
      if (current()) this.patchColumn(ref, { loading: false, error: errorText(error) });
      return null;
    }
  }
  // Asks one machine, or all of them, to inspect again now.
  refresh(machine?: MachineRef) {
    if (!this.ready()) return Promise.resolve();
    if (machine === undefined) return this.load(true);
    const column = this.column(machine);
    if (column?.reach !== 'ok') return Promise.resolve();
    this.update({ changes: { ...this.state.changes, ...withoutFailures({ [machine]: this.state.changes[machine] ?? {} }) } });
    return this.track(this.readSkills(machine, true, this.current()));
  }

  // Why `skill` can't be changed on `machine` now, or null.
  blocked(machine: MachineRef, skill?: SkillId): string | null {
    if (!this.ready()) return MACHINES_WORDS.agentFirst;
    const column = this.column(machine);
    if (!column || column.reach !== 'ok' || !column.skills) return MACHINES_WORDS.unreachable;
    if (skill && this.state.changes[machine]?.[rowKey(skill)] === 'working') return MACHINES_WORDS.changing;
    return null;
  }
  // Sends one change to `machines` once the changes already sent there have finished, and follows each run it starts.
  // Resolves with the run each machine finished, or null for one that didn't start or couldn't be followed.
  private send(skill: { source: string; name: string }, action: Action, machines: readonly MachineRef[] | 'all', requestId: string, current: Current, revision?: string) {
    if (machines !== 'all') for (const ref of machines) this.setChange(ref, skill, 'working');
    const targets = machines === 'all' ? this.state.columns.map(column => column.ref) : machines;
    const earlier = targets.flatMap(ref => this.queues.get(ref) ?? []);
    const sent = Promise.allSettled(earlier).then(() => current() ? this.sendNow(skill, action, machines, requestId, current, revision) : new Map<MachineRef, RunView | null>());
    for (const ref of targets) this.queues.set(ref, sent);
    void sent.finally(() => { for (const ref of targets) if (this.queues.get(ref) === sent) this.queues.delete(ref); }).catch(() => {});
    return sent;
  }
  private async sendNow(skill: { source: string; name: string }, action: Action, machines: readonly MachineRef[] | 'all', requestId: string, current: Current, revision?: string) {
    const before = new Map(this.state.columns.map(column => [column.ref, column.inspectedAt]));
    let results: OperationOutput<'applySkillOnMachines'>['results'];
    try {
      const reply = await operation(this.bridge!, 'applySkillOnMachines', { scope: SCOPE, requestId, source: skill.source, name: skill.name, action, machines, ...(revision ? { revision } : {}) });
      if (!current(reply)) return new Map<MachineRef, RunView | null>();
      results = reply.data.results;
    } catch (error) {
      if (current()) {
        if (machines !== 'all') for (const ref of machines) this.setChange(ref, skill, null);
        this.update({ error: errorText(error) });
      }
      return new Map<MachineRef, RunView | null>();
    }
    const finished = await Promise.all(results.map(async ({ machine, name, outcome }): Promise<[MachineRef, RunView | null]> => {
      if (outcome.status === 'offline') {
        this.setChange(machine, skill, null);
        this.update({ notices: [...this.state.notices, offlineNotice(name)] });
        return [machine, null];
      }
      if (outcome.status === 'refused') { this.setChange(machine, skill, { failed: outcome.reason }); return [machine, null]; }
      this.setChange(machine, skill, 'working');
      return [machine, await this.follow(machine, outcome.runId, skill, action, current, before.get(machine) ?? null)];
    }));
    return new Map(finished);
  }
  // Polls a target's run until it finishes, then reads that machine again until it reports a check newer than
  // `before`, the one shown when the change was sent; the machine inspects only after the run has finished.
  private async follow(ref: MachineRef, runId: string, skill: SkillId, action: Action, current: Current, before: string | null) {
    for (;;) {
      await this.wait();
      if (!current()) return null;
      let run: RunView;
      try {
        const reply = await operation(this.bridge!, 'machineRun', { scope: SCOPE, machine: ref, runId });
        if (!current(reply)) return null;
        run = reply.data;
      } catch (error) {
        if (current()) this.setChange(ref, skill, { failed: errorText(error) });
        return null;
      }
      if (live(run)) continue;
      for (let read = 0; read <= SETTLE_READS; read++) {
        if (read > 0) await this.wait();
        if (!current()) return null;
        const at = await this.readSkills(ref, false, current);
        if (at === null || newer(at, before)) break;
      }
      if (!current()) return null;
      this.setChange(ref, skill, run.state === 'succeeded' ? null : { failed: cellFailed(action, run.state, runCauses(run)[0] ?? '') });
      return run;
    }
  }
  private act(work: (requestId: string, current: Current) => Promise<unknown>) {
    if (!this.ready()) return Promise.resolve();
    const current = this.current();
    this.update({ notices: [], error: null });
    return this.track(work(crypto.randomUUID(), current).then(() => {}));
  }
  // Turns `skill` on or off on one machine, applied there now.
  setCell(skill: SkillId, machine: MachineRef, on: boolean) {
    const source = skill.source;
    if (source === null || this.blocked(machine, skill)) return Promise.resolve();
    return this.act((requestId, current) => this.send({ source, name: skill.name }, on ? 'install' : 'remove', [machine], requestId, current));
  }
  // Installs a skill on the ticked machines, or every machine online now.
  // `revision` pins a full commit ID; empty installs the latest version.
  install(source: string, name: string, machines: readonly MachineRef[] | 'all', revision = '') {
    const skill = { source: source.trim(), name: name.trim() }, pin = revision.trim();
    if (!skill.source || !skill.name || revisionError(pin) || (machines !== 'all' && (!machines.length || machines.some(ref => this.blocked(ref, skill))))) return Promise.resolve();
    return this.act((requestId, current) => this.send(skill, 'install', machines, requestId, current, pin || undefined));
  }
  // Installs a skill one machine has on others that don't.
  copy(skill: SkillId, to: readonly MachineRef[]) {
    const source = skill.source;
    if (source === null || !to.length || to.some(ref => this.blocked(ref, skill))) return Promise.resolve();
    return this.act((requestId, current) => this.send({ source, name: skill.name }, 'install', to, requestId, current));
  }
  // Installs on `to`, then removes from `from` once that install succeeded, as one user action.
  move(skill: SkillId, from: MachineRef, to: MachineRef) {
    const source = skill.source;
    if (source === null || from === to || this.blocked(from, skill) || this.blocked(to, skill)) return Promise.resolve();
    const id = { source, name: skill.name };
    return this.act(async (requestId, current) => {
      const installed = (await this.send(id, 'install', [to], requestId, current)).get(to);
      if (!current()) return;
      if (installed?.state === 'succeeded') await this.send(id, 'remove', [from], requestId, current);
      else this.update({ notices: [...this.state.notices, keptNotice(skill.name, this.column(from)?.name ?? from, this.column(to)?.name ?? to)] });
    });
  }
  // Turns remote access on or off here, then reads the machines again.
  setRemoteAccess(enabled: boolean) {
    if (!this.ready() || this.state.switching) return Promise.resolve();
    const current = this.current();
    this.update({ switching: true, error: null });
    return this.track((async () => {
      const reply = await operation(this.bridge!, 'setRemoteAccess', { scope: SCOPE, enabled });
      if (!current(reply)) return;
      this.update({ access: reply.data });
      await this.load(false);
    })().catch(error => { if (current()) this.update({ error: errorText(error) }); }).finally(() => { if (current()) this.update({ switching: false }); }));
  }
  dispose() {
    this.disposed = true; this.epoch++; this.stopWaits(); this.unlistenMachine(); this.listeners.clear();
  }
}
