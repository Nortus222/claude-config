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
  const handlers: Record<string, (input: any) => unknown> = {
    inspectSetups: () => ({ generation: '1', items: [{ setupId: 'local', trusted: true, repository: '/repo', accountId: null }], nextCursor: null }),
    setupReview: () => review(), previewChange: input => preview({ change: input.change }),
    applyChange: () => ({ status: 'started', run: run() }), getRun: () => run(), listRuns: () => ({ runs: [], nextBefore: null }),
    abandonRun: () => run({ state: 'abandoned', abandonedAt: '2026-10-16T12:00:00.000Z', result: { status: 'interrupted', message: 'Abandoned' } }),
  };
  const bridge: Bridge = { subscribe: async receive => { listeners.add(receive); return () => { listeners.delete(receive); }; }, invoke: async (command, args) => {
    const issuedGeneration = generation;
    if (command === 'operation') { const name = String(args!.name); calls.push({ name, input: args!.input }); return { generation: issuedGeneration, data: await handlers[name]!(args!.input) }; }
    return { generation: issuedGeneration, data: command === 'agent_status' ? status() : command === 'inspect_machine'
      ? { profile: { repo: '/repo', revision: 'abc', overrides: '/overrides', issues: [] }, items: [], probeErrors: [], status: status() } : null };
  } };
  const machine = new MachineController(bridge); await machine.connect();
  return { bridge, machine, handlers, calls, emit: (event: HostEvent extends infer E ? E extends HostEvent ? Omit<E, 'generation'> : never : never) => { for (const receive of listeners) receive({ ...event, generation } as HostEvent); },
    reconnect: async () => { generation++; await machine.connect(); await flush(); } };
}
