import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChangePreview, OperationName, RunView } from '@nortuscc/agent/operations';
import { MachineController } from '../src/controller.ts';
import { SkillsController, effectiveChoice, eligibleUpdates } from '../src/skills-controller.ts';
import type { Bridge, HostEvent } from '../src/bridge.ts';
import { row, inventory, updates, receipt, preview, status, inspection, deferred, choiceChange } from './support/skills-data.ts';

type Handler = (input: Readonly<Record<string, unknown>>) => unknown;
async function connected(handlers: Partial<Record<OperationName, Handler>> = {}, maintenance = () => null as string | null) {
  const calls: Array<{ name: OperationName; input: Readonly<Record<string, unknown>> }> = [];
  const listeners = new Set<(event: HostEvent) => void>();
  const box = { generation: 1, rows: inventory(), run: receipt(), preview: preview() };
  const bridge: Bridge = {
    subscribe: async listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    invoke: async (command, args) => {
      let data: unknown;
      if (command === 'operation') {
        const name = args!.name as OperationName, input = args!.input as Readonly<Record<string, unknown>>;
        calls.push({ name, input });
        data = await (handlers[name]?.(input) ?? (name === 'inspectIntent' ? box.rows : name === 'inspectUpdates' ? updates() : name === 'previewChange' ? preview((input as { change: Parameters<typeof preview>[0] }).change)
          : name === 'applyChange' ? { status: 'started', run: box.run } : name === 'getRun' || name === 'cancelRun' ? box.run : null));
      } else data = command === 'agent_status' ? status() : command === 'inspect_machine' ? inspection() : null;
      return { generation: box.generation, data };
    },
  };
  const machine = new MachineController(bridge); await machine.connect();
  const skills = new SkillsController(bridge, machine, { maintenance });
  const emit = (event: object, generation = box.generation) => { for (const listener of listeners) listener({ version: 3, generation, ...event } as HostEvent); };
  return { skills, machine, calls, box, emit };
}
async function loaded(handlers: Partial<Record<OperationName, Handler>> = {}, maintenance?: () => string | null) {
  const f = await connected(handlers, maintenance); await f.skills.reload(); return f;
}
const names = (f: Awaited<ReturnType<typeof connected>>) => f.calls.map(c => c.name);

test('browser preview has no skills data or actions', async () => {
  const skills = new SkillsController(null, new MachineController(null)); skills.enter(); await skills.reload(); await skills.check();
  assert.equal(skills.state.view, null); assert.match(skills.blocked()!, /desktop app/);
});
test('Skills reads lazily, caches on entry, and never checks upstream implicitly', async () => {
  const f = await connected(); assert.equal(f.calls.length, 0);
  f.skills.enter(); await f.skills.idle(); f.skills.leave(); f.skills.enter(); await f.skills.idle();
  assert.deepEqual(names(f), ['inspectIntent']); assert.deepEqual(f.calls[0]!.input, { scope: { kind: 'machine' }, section: 'skills', limit: 100 });
  await f.skills.reload(); assert.equal(f.calls.length, 2);
});
test('intent pagination preserves all source-qualified rows and rejects a changing generation', async () => {
  const f = await loaded({ inspectIntent: input => input.cursor ? inventory([row('other')]) : inventory([row()], { nextCursor: 'page-2' }) });
  assert.equal(f.skills.state.view?.items.length, 2);
  const g = await loaded({ inspectIntent: input => input.cursor ? inventory([row('other')], { generation: 'changed' }) : inventory([row()], { nextCursor: 'page-2' }) });
  assert.equal(g.skills.state.view, null); assert.match(g.skills.state.error!, /changed/i);
});
test('malformed intent replies never expose partial rows', async () => {
  const f = await loaded({ inspectIntent: () => ({ invalid: true }) }); assert.equal(f.skills.state.view, null); assert.match(f.skills.state.error!, /response/i);
  assert.doesNotMatch(f.skills.state.detail, /Reading/, 'a failed read does not keep its progress line');
});
test('choosing Default sends reset and shows the profile default', async () => {
  const f = await loaded(); f.box.rows = inventory([row('tdd', { choice: false, enabled: false })]); await f.skills.reload();
  f.box.run = receipt('succeeded'); f.box.rows = inventory([row()]);
  await f.skills.setChoice('owner/skills', 'tdd', 'inherit');
  assert.deepEqual(f.calls.find(c => c.name === 'previewChange')!.input.change, { kind: 'machineIntent', patch: { kind: 'skill', source: 'owner/skills', name: 'tdd', action: 'reset' } });
  assert.equal(f.skills.state.view?.items[0]?.choice, null); assert.equal(effectiveChoice(f.skills.state.view!.items[0]!), true);
  assert.match(f.skills.state.detail, /Saved.*Default/);
});
test('the page reports a choice as saved only after its run succeeds', async () => {
  const f = await loaded(); await f.skills.setChoice('owner/skills', 'tdd', 'off');
  assert.equal(f.skills.state.view!.items[0]!.choice, null); assert.doesNotMatch(f.skills.state.detail, /Saved/); assert.ok(f.skills.state.saving);
  f.box.run = receipt('succeeded'); f.box.rows = inventory([row('tdd', { choice: false, enabled: false })]);
  f.emit({ event: 'operation-run', runId: 'run-1' }); await f.skills.idle();
  assert.match(f.skills.state.detail, /Saved.*Off/); assert.equal(f.skills.state.view!.items[0]!.choice, false); assert.equal(f.skills.state.saving, null);
  assert.match(f.skills.state.detail, /Apply on Changes/); assert.doesNotMatch(f.skills.state.detail, /Review & apply/);
});
test('a status for another run does not mark this save complete', async () => {
  const f = await loaded(); await f.skills.setChoice('owner/skills', 'tdd', 'off');
  const count = names(f).filter(n => n === 'getRun').length;
  f.emit({ event: 'operation-run', runId: 'run-1' });
  f.emit({ event: 'status', runId: 'other-run', status: status() }); await f.skills.idle();
  assert.equal(f.skills.state.run?.state, 'running'); assert.doesNotMatch(f.skills.state.detail, /Saved/); assert.ok(f.skills.state.saving);
  assert.equal(names(f).filter(n => n === 'getRun').length, count + 1);
  f.box.run = receipt('succeeded'); f.box.rows = inventory([row('tdd', { choice: false })]);
  f.emit({ event: 'status', runId: 'run-1', status: status() }); await f.skills.idle(); assert.match(f.skills.state.detail, /Saved/);
});
test('failed or interrupted runs preserve the last confirmed choice and require reload', async () => {
  for (const state of ['failed', 'interrupted'] as const) {
    const f = await loaded(); f.box.run = receipt(state); await f.skills.setChoice('owner/skills', 'tdd', 'off');
    assert.equal(f.skills.state.view!.items[0]!.choice, null); assert.doesNotMatch(f.skills.state.detail, /Saved/); assert.match(f.skills.state.stale!, /Reload/);
  }
});
test('a pre-write refusal retains the last confirmed choice and permits a fresh attempt', async () => {
  const f = await loaded({ previewChange: () => { throw new Error('LOCKED: another apply is active'); } });
  await f.skills.setChoice('owner/skills', 'tdd', 'off'); assert.equal(f.skills.state.view!.items[0]!.choice, null); assert.equal(f.skills.state.stale, null); assert.match(f.skills.state.error!, /LOCKED/);
});
test('an ambiguous apply reply requires Reload without claiming rollback or success', async () => {
  const f = await loaded({ applyChange: () => { throw new Error('Connection lost after acceptance'); } }); await f.skills.setChoice('owner/skills', 'tdd', 'off');
  assert.equal(f.skills.state.view!.items[0]!.choice, null); assert.match(f.skills.state.stale!, /confirm.*Reload/i); assert.doesNotMatch(f.skills.state.detail, /Saved|unchanged|rolled back/);
});
test('a stale choice apply exposes the refreshed preview and requires an explicit retry', async () => {
  const f = await loaded({ applyChange: () => ({ status: 'stale', preview: preview(choiceChange, 'new-plan') }) }); await f.skills.setChoice('owner/skills', 'tdd', 'off');
  assert.equal(f.skills.state.preview?.planId, 'new-plan'); assert.doesNotMatch(f.skills.state.detail, /Saved/); assert.equal(names(f).filter(n => n === 'applyChange').length, 1);
});
test('unknown skill identities and unchanged choices never write', async () => {
  const f = await loaded(); await f.skills.setChoice('elsewhere/skills', 'tdd', 'off'); await f.skills.setChoice('owner/skills', 'tdd', 'inherit'); assert.deepEqual(names(f), ['inspectIntent']);
});
test('maintenance and machine applies block writes and upstream checks', async () => {
  let maintenance: string | null = 'An app update is installing.'; const f = await loaded({}, () => maintenance);
  await f.skills.setChoice('owner/skills', 'tdd', 'off'); await f.skills.check(); assert.deepEqual(names(f), ['inspectIntent']);
  maintenance = null; f.emit({ event: 'status', status: status({ applying: true }) }); await f.skills.setChoice('owner/skills', 'tdd', 'off'); assert.deepEqual(names(f), ['inspectIntent']);
});
test('Check upstream is single-flight and reports unavailable checks', async () => {
  const hold = deferred<unknown>(); const f = await loaded({ inspectUpdates: () => hold.promise }); const first = f.skills.check(); const second = f.skills.check();
  assert.equal(names(f).filter(n => n === 'inspectUpdates').length, 1); hold.resolve(updates({ unavailable: true, items: [] })); await first; await second;
  assert.equal(f.skills.state.check?.unavailable, true); assert.deepEqual(f.skills.state.selected, []);
});
test('eligible updates use source and name, effective On, and the shared repair route', () => {
  const view = { ...inventory([row(), row('off', { choice: false }), row('native'), row('twin', { source: 'other/skills' })]), items: [row(), row('off', { choice: false }), row('native'), row('twin', { source: 'other/skills' })] };
  const base = updates().items[0]!;
  const check = updates({ items: [base, { ...base, name: 'off', key: 'off' }, { ...base, name: 'native', key: 'native', repairRoute: 'addition' }, { ...base, name: 'twin', key: 'twin' }] });
  assert.deepEqual([...eligibleUpdates(view, check)], ['skills:update:tdd']);
});
test('Check upstream lists updates and Preview update shows the plan before Apply', async () => {
  const f = await loaded(); await f.skills.check(); assert.equal(f.skills.state.check!.items[0]!.state, 'outdated');
  f.skills.toggle('skills:update:tdd'); assert.equal(names(f).includes('previewChange'), false); await f.skills.previewUpdate();
  assert.deepEqual(f.calls.find(c => c.name === 'previewChange')!.input.change, { kind: 'update', only: ['skills:update:tdd'], targets: ['claude', 'codex'], authorManifest: false });
  assert.equal(f.skills.state.preview?.change.kind, 'update'); assert.equal(names(f).includes('applyChange'), false);
  f.box.run = receipt('running', f.skills.state.preview!.change as Parameters<typeof receipt>[1]); await f.skills.applyUpdate(); assert.equal(names(f).filter(n => n === 'applyChange').length, 1);
  assert.equal(f.skills.state.preview, null); assert.equal(f.skills.state.run?.state, 'running');
});
test('changing selection clears the preview and prevents applying a spent or missing preview', async () => {
  const f = await loaded(); await f.skills.check(); f.skills.toggle('skills:update:tdd'); await f.skills.previewUpdate(); f.skills.toggle('skills:update:tdd');
  assert.equal(f.skills.state.preview, null); await f.skills.applyUpdate(); assert.equal(names(f).includes('applyChange'), false);
});
test('a stale update apply replaces the preview without applying it again', async () => {
  const f = await loaded({ applyChange: () => ({ status: 'stale', preview: preview({ kind: 'update', only: ['skills:update:tdd'], authorManifest: false }, 'new-plan') }) });
  await f.skills.check(); f.skills.toggle('skills:update:tdd'); await f.skills.previewUpdate(); await f.skills.applyUpdate();
  assert.equal(f.skills.state.preview?.planId, 'new-plan'); assert.equal(names(f).filter(n => n === 'applyChange').length, 1);
});
test('leaving Skills fences an outstanding update preview', async () => {
  const held = deferred<ChangePreview>(); const f = await loaded({ previewChange: () => held.promise }); await f.skills.check(); f.skills.toggle('skills:update:tdd');
  const pending = f.skills.previewUpdate(); f.skills.leave(); held.resolve(preview({ kind: 'update', only: ['skills:update:tdd'], authorManifest: false })); await pending; assert.equal(f.skills.state.preview, null);
});
test('disconnect and disposal fence late replies, and reconnect requires a fresh read', async () => {
  const held = deferred<unknown>(); const f = await connected({ inspectIntent: () => held.promise }); const pending = f.skills.reload();
  f.emit({ event: 'disconnected', detail: 'Backend exited' }); f.box.generation = 2; await f.machine.connect(); held.resolve(inventory()); await pending;
  assert.equal(f.skills.state.view, null); assert.equal(f.machine.state.connection, 'connected');
  const second = deferred<unknown>(); const g = await connected({ inspectIntent: () => second.promise }); const reading = g.skills.reload(); const before = g.skills.state;
  g.skills.dispose(); second.resolve(inventory()); await reading; assert.equal(g.skills.state, before);
});
test('an active Skills update cancels through its shared run', async () => {
  const f = await loaded(); await f.skills.check(); f.skills.toggle('skills:update:tdd'); await f.skills.previewUpdate(); f.box.run = receipt('running', f.skills.state.preview!.change as Parameters<typeof receipt>[1]); await f.skills.applyUpdate();
  await f.skills.cancel(); assert.deepEqual(f.calls.find(c => c.name === 'cancelRun')!.input, { scope: { kind: 'machine' }, runId: 'run-1' });
});
test('a foreign apply invalidates an outstanding inventory read', async () => {
  const held = deferred<unknown>(); const f = await connected({ inspectIntent: () => held.promise }); const pending = f.skills.reload();
  f.emit({ event: 'status', runId: 'foreign', status: status({ applying: true }) }); held.resolve(inventory()); await pending;
  assert.equal(f.skills.state.view, null); assert.equal(f.skills.state.stale, null); assert.equal(f.skills.state.outdated, true);
});
test('a receipt invalidation during a held running read triggers another read', async () => {
  const held = deferred<RunView>(); let reads = 0;
  const f = await loaded({ getRun: () => ++reads === 2 ? held.promise : f.box.run });
  await f.skills.setChoice('owner/skills', 'tdd', 'off');
  f.emit({ event: 'operation-run', runId: 'run-1' });
  f.box.run = receipt('succeeded'); f.box.rows = inventory([row('tdd', { choice: false })]);
  f.emit({ event: 'operation-run', runId: 'run-1' }); held.resolve(receipt()); await f.skills.idle();
  assert.equal(f.skills.state.run?.state, 'succeeded'); assert.match(f.skills.state.detail, /Saved/); assert.equal(reads, 3);
});
test('reconnecting during a save re-reads its run and confirms its final choice', async () => {
  const f = await loaded(); await f.skills.setChoice('owner/skills', 'tdd', 'off'); f.emit({ event: 'disconnected', detail: 'Backend exited' });
  f.box.generation = 2; f.box.run = receipt('succeeded'); f.box.rows = inventory([row('tdd', { choice: false })]); await f.machine.connect(); await f.skills.idle();
  assert.equal(f.skills.state.run?.state, 'succeeded'); assert.equal(f.skills.state.view!.items[0]!.choice, false); assert.match(f.skills.state.detail, /Saved/);
});
test('an update that finishes before acceptance is still reported as succeeded', async () => {
  const f = await loaded(); await f.skills.check(); f.skills.toggle('skills:update:tdd'); await f.skills.previewUpdate();
  f.box.run = receipt('succeeded', f.skills.state.preview!.change as Parameters<typeof receipt>[1]); await f.skills.applyUpdate();
  assert.match(f.skills.state.detail, /update succeeded/);
});
test('a disconnect before acceptance clears the pending saving indicator', async () => {
  const held = deferred<unknown>(), called = deferred<void>();
  const f = await loaded({ applyChange: () => { called.resolve(); return held.promise; } });
  const saving = f.skills.setChoice('owner/skills', 'tdd', 'off'); await called.promise;
  f.emit({ event: 'disconnected', detail: 'Backend exited' }); held.resolve({ status: 'started', run: receipt() }); await saving;
  assert.equal(f.skills.state.saving, null); assert.equal(f.skills.state.run, null);
});
test('Reload can refresh an unconfirmed active run without resubmitting the choice', async () => {
  let unavailable = true;
  const f = await loaded({ getRun: () => { if (unavailable) throw new Error('Temporary read failure'); return f.box.run; } });
  await f.skills.setChoice('owner/skills', 'tdd', 'off'); assert.match(f.skills.state.error!, /Temporary read failure/);
  unavailable = false; f.box.run = receipt('succeeded'); f.box.rows = inventory([row('tdd', { choice: false })]); await f.skills.reload();
  assert.equal(f.skills.state.run?.state, 'succeeded'); assert.match(f.skills.state.detail, /Saved/); assert.equal(names(f).filter(n => n === 'applyChange').length, 1);
});
test('a delayed receipt from the previous run cannot replace a newly accepted run', async () => {
  const held = deferred<RunView>(), reading = deferred<void>();
  const nextPreview = deferred<ChangePreview>(), previewing = deferred<void>(), accepting = deferred<void>();
  let reads = 0, previews = 0, applies = 0;
  const f = await loaded({
    getRun: () => { if (++reads === 2) { reading.resolve(); return held.promise; } return f.box.run; },
    previewChange: input => { if (++previews === 2) { previewing.resolve(); return nextPreview.promise; } return preview(input.change as Parameters<typeof preview>[0]); },
    applyChange: () => { if (++applies === 2) accepting.resolve(); return { status: 'started', run: f.box.run }; },
  });
  f.box.run = receipt('succeeded'); f.box.rows = inventory([row('tdd', { choice: false })]); await f.skills.setChoice('owner/skills', 'tdd', 'off');
  const saving = f.skills.setChoice('owner/skills', 'tdd', 'on'); await previewing.promise;
  f.emit({ event: 'operation-run', runId: 'run-1' }); await reading.promise;
  f.box.run = { ...receipt(), runId: 'run-2' }; f.box.rows = inventory([row('tdd', { choice: true })]);
  nextPreview.resolve(preview({ kind: 'machineIntent', patch: { kind: 'skill', source: 'owner/skills', name: 'tdd', action: 'enable' } }));
  await accepting.promise; await Promise.resolve(); held.resolve(receipt('succeeded')); await saving; await f.skills.idle();
  assert.equal(f.skills.state.run?.runId, 'run-2'); assert.equal(f.skills.state.run?.state, 'running');
});
test('a matching post-run status refreshes choices after inspection catches up', async () => {
  let inspectionReady = false, saved = false, rows = inventory();
  const f = await loaded({ inspectIntent: () => {
    if (saved && !inspectionReady) throw new Error('NO_REPORT: inspection pending');
    return rows;
  } });
  saved = true; f.box.run = receipt('succeeded'); await f.skills.setChoice('owner/skills', 'tdd', 'off');
  assert.match(f.skills.state.detail, /Saved/); assert.equal(f.skills.state.view!.items[0]!.choice, null);
  inspectionReady = true; rows = inventory([row('tdd', { choice: false })]);
  f.emit({ event: 'status', runId: 'other-run', status: status() }); await f.skills.idle(); assert.equal(f.skills.state.view!.items[0]!.choice, null);
  f.emit({ event: 'status', runId: 'run-1', status: status() }); await f.skills.idle();
  assert.equal(f.skills.state.view!.items[0]!.choice, false); assert.equal(f.skills.state.stale, null); assert.match(f.skills.state.detail, /Saved/);
});
const settled = async (f: Awaited<ReturnType<typeof connected>>) => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); await f.skills.idle(); };
test('an apply elsewhere on this Mac never shows Skills as changed; an open Skills page reads again when it ends', async () => {
  const f = await loaded(); f.skills.enter(); await settled(f);
  const reads = names(f).filter(n => n === 'inspectIntent').length;
  f.emit({ event: 'status', status: status({ applying: true }) });
  f.emit({ event: 'operation-run', runId: 'foreign' }); await settled(f);
  assert.equal(f.skills.state.stale, null); assert.equal(f.skills.state.outdated, true);
  assert.ok(f.machine.state.busy); assert.match(f.skills.blocked()!, /apply is running/);
  assert.equal(names(f).filter(n => n === 'inspectIntent').length, reads, 'nothing is read while the Mac is busy');
  f.box.rows = inventory([row('tdd', { choice: false, enabled: false })]);
  f.emit({ event: 'status', runId: 'foreign', status: status({ applying: false }) }); await settled(f);
  assert.equal(names(f).filter(n => n === 'inspectIntent').length, reads + 1);
  assert.equal(f.skills.state.view!.items[0]!.choice, false); assert.equal(f.skills.state.outdated, false); assert.equal(f.skills.state.stale, null);
});
test('Skills left during an apply reads again when entered, and a reconnect reads an open page again', async () => {
  const f = await loaded(); f.skills.enter(); await settled(f); f.skills.leave();
  f.emit({ event: 'operation-run', runId: 'foreign' }); await settled(f);
  const reads = names(f).filter(n => n === 'inspectIntent').length;
  assert.equal(f.skills.state.outdated, true);
  f.skills.enter(); await settled(f);
  assert.equal(names(f).filter(n => n === 'inspectIntent').length, reads + 1);
  f.emit({ event: 'disconnected', detail: 'Backend exited' }); f.box.generation = 2; await f.machine.connect(); await settled(f);
  assert.equal(names(f).filter(n => n === 'inspectIntent').length, reads + 2); assert.ok(f.skills.state.view);
});
