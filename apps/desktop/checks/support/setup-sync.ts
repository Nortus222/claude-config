import { decodeRunView, type OperationOutput, type RunView } from '@nortuscc/agent/operations';
import { MachineController } from '../../src/controller.ts';
import type { Bridge, HostEvent } from '../../src/bridge.ts';
export const revision = { kind: 'local' as const, commit: 'b'.repeat(40) };
export const review = (fields = {}): OperationOutput<'setupReview'> => ({ generation: 1, setupId: 'local', revision,
  rows: [{ itemId: 'setting:a', kind: 'setting', change: 'changed', held: false, conflict: true, before: 'old', after: 'new', mine: 'mine' },
    { itemId: 'setting:b', kind: 'setting', change: 'added', held: false, conflict: false, after: 'offered' }], pinGroups: [], nextCursor: null, ...fields });
export const change = { kind: 'setupApply' as const, setupId: 'local', revision, choices: [{ itemId: 'setting:a', action: 'accept' as const }] };
export const preview = (fields = {}): OperationOutput<'previewChange'> => ({ planId: 'plan', scope: { kind: 'machine' }, generation: '1', change,
  plan: { kind: 'apply', steps: [], skipped: [] }, nextActions: [], actionEffects: ['Saves reviewed choices'], ...fields });
export const run = (fields: Partial<RunView> = {}): RunView => decodeRunView({ runId: 'setup-run', state: 'running', operation: 'applyChange', scope: { kind: 'machine' },
  intent: { requestId: 'request', inputDigest: 'a'.repeat(64), planId: 'plan', change,
    parity: { kind: 'setupApply', generation: '1', baselineDigest: 'a'.repeat(64), planDigest: 'a'.repeat(64), plannedKeys: ['setting:a', 'setting:b'] } },
  intentSaved: false, steps: [], result: null,
  parity: { kind: 'setupApply', state: 'partial', committedKeys: ['setting:a'], remainingKeys: ['setting:b'], backupIds: ['backup-1'] }, ...fields });
export const status = (fields = {}) => ({ at: 'now', policy: 'notify' as const, paused: null, trusted: true, applying: false, pending: [], drift: [], conflicts: [], probeErrors: [], counts: { pending: 0, held: 0, ready: 0, drift: 0 }, ...fields });
export const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
export async function fixture() {
  let generation = 1;
  const listeners = new Set<(event: HostEvent) => void>();
  const calls: { name: string; input: any }[] = [];
  // Every bridge command, operations included, so a test can prove a legacy command was never sent.
  const commands: string[] = [];
  // The machine inspection `inspect_machine` answers; tests replace its items, then call `machine.inspect()`.
  const report: { profile: { repo: string; revision: string | null; overrides: string; issues: { layer: 'base' | 'pin' | 'machine' | 'profile'; source: string; path: string; message: string }[] }; items: any[]; probeErrors: string[] } =
    { profile: { repo: '/repo', revision: 'abc', overrides: '/overrides', issues: [] }, items: [], probeErrors: [] };
  const handlers: Record<string, (input: any) => unknown> = {
    inspectProfiles: () => ({ followed: null, available: [{ name: 'default', extends: null }] }),
    inspectSetups: () => ({ generation: '1', items: [{ setupId: 'local', trusted: true, repository: '/repo', accountId: null }], nextCursor: null }),
    setupReview: () => review(), previewChange: input => preview({ change: input.change }),
    applyChange: () => ({ status: 'started', run: run() }), getRun: () => run(), listRuns: () => ({ runs: [], nextBefore: null }),
    abandonRun: () => run({ state: 'abandoned', abandonedAt: '2026-10-16T12:00:00.000Z', result: { status: 'interrupted', message: 'Abandoned' } }),
  };
  const bridge: Bridge = { subscribe: async receive => { listeners.add(receive); return () => { listeners.delete(receive); }; }, invoke: async (command, args) => {
    const issuedGeneration = generation; commands.push(command);
    if (command === 'operation') { const name = String(args!.name); calls.push({ name, input: args!.input }); return { generation: issuedGeneration, data: await handlers[name]!(args!.input) }; }
    return { generation: issuedGeneration, data: command === 'agent_status' ? status() : command === 'inspect_machine'
      ? { ...report, status: status() } : null };
  } };
  const machine = new MachineController(bridge); await machine.connect();
  return { bridge, machine, handlers, calls, commands, report, emit: (event: HostEvent extends infer E ? E extends HostEvent ? Omit<E, 'generation'> : never : never) => { for (const receive of listeners) receive({ ...event, generation } as HostEvent); },
    reconnect: async () => { generation++; await machine.connect(); await flush(); } };
}
// One inspected item of each kind the Changes page shows: two waiting to apply, one changed on this Mac,
// one that cannot be applied and one already in sync.
export const localItems = () => [
  { key: 'config:claude:settings.json#model', domain: 'config', target: 'claude', label: 'settings.json#model', group: 'claude', state: 'repo-ahead', disposition: 'apply', from: { layer: 'profile', source: 'personal' } },
  { key: 'skill:tdd', domain: 'skills', label: 'tdd', group: 'mattpocock/skills', state: 'missing', disposition: 'apply', from: { layer: 'base', source: 'base' } },
  { key: 'config:claude:CLAUDE.md', domain: 'config', target: 'claude', label: 'CLAUDE.md', group: 'claude', state: 'local-ahead', disposition: 'capture', from: { layer: 'base', source: 'base' } },
  { key: 'integration:browser', domain: 'integrations', label: 'browser', group: 'mcp', state: 'conflict', disposition: 'blocked', note: 'Another browser server is configured by hand', from: { layer: 'machine', source: 'overrides' } },
  { key: 'skill:grill', domain: 'skills', label: 'grill', group: 'mattpocock/skills', state: 'ok', disposition: 'in-sync', from: { layer: 'pin', source: 'mattpocock/skills' } },
];
export const localChange = { kind: 'reconcile' as const, only: ['config:claude:settings.json#model', 'skill:tdd'] };
// A durable reconcile run with partial evidence: one key written, one remaining.
export const localRun = (fields: Partial<RunView> = {}): RunView => decodeRunView({ runId: 'local-run', state: 'running', operation: 'applyChange', scope: { kind: 'machine' },
  intent: { requestId: 'local-request', inputDigest: 'a'.repeat(64), planId: 'local-plan', change: localChange,
    parity: { kind: 'reconcile', generation: '0', baselineDigest: 'a'.repeat(64), planDigest: 'a'.repeat(64), plannedKeys: localChange.only } },
  intentSaved: false, steps: [], result: null,
  parity: { kind: 'reconcile', state: 'partial', committedKeys: ['skill:tdd'], remainingKeys: ['config:claude:settings.json#model'], backupIds: ['backup-1'] }, ...fields });
