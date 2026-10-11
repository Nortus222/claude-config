import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateController, type UpdateBridge } from '../src/update-controller.ts';
import { decodeUpdateSnapshot, type UpdateCommand, type UpdateSnapshot } from '../shared/update-protocol.ts';

const snapshot = (fields: Partial<UpdateSnapshot> = {}): UpdateSnapshot => ({ installedVersion: '0.1.0', enabled: true, automaticChecks: true, phase: 'idle', availableVersion: null, notes: null, downloadedBytes: 0, totalBytes: null, diagnostic: null, ...fields });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(handler: (command: UpdateCommand, args?: unknown) => UpdateSnapshot | Promise<UpdateSnapshot>) {
  const calls: Array<[UpdateCommand, unknown]> = [];
  let timer: (() => void) | null = null;
  const bridge: UpdateBridge = { invoke: async (command, args) => { calls.push([command, args]); return handler(command, args); } };
  const controller = new UpdateController(bridge, (callback) => { timer = callback; return () => { if (timer === callback) timer = null; }; });
  return { controller, calls, tick: async () => { const callback = timer; timer = null; callback?.(); await settle(); }, hasTimer: () => timer !== null };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('startup reads native state and checks once independently, respecting disabled checks without downloading', async () => {
  for (const fields of [{}, { automaticChecks: false }, { enabled: false }]) {
    const f = fixture(() => snapshot(fields));
    await f.controller.start(); await f.controller.start();
    assert.deepEqual(f.calls, fields.automaticChecks === false || fields.enabled === false ? [['update_state', undefined]] : [['update_state', undefined], ['check_update', { automatic: true }]]);
    assert.equal(f.controller.state.update?.installedVersion, '0.1.0');
    assert.equal(f.hasTimer(), false);
    f.controller.dispose();
  }
});

test('download polls progress and coalesces duplicate actions; completion rejects a stale poll', async () => {
  const download = deferred<UpdateSnapshot>(); const poll = deferred<UpdateSnapshot>();
  let reads = 0;
  const f = fixture((command) => command === 'download_update' ? download.promise : command === 'update_state' && ++reads > 1 ? poll.promise : snapshot({ automaticChecks: false, phase: 'available', availableVersion: '0.2.0' }));
  await f.controller.start();
  const action = f.controller.download(); const duplicate = f.controller.download();
  await f.tick();
  assert.equal(f.controller.state.pending, true);
  assert.equal(f.calls.filter(([command]) => command === 'download_update').length, 1);
  download.resolve(snapshot({ phase: 'verified', availableVersion: '0.2.0' }));
  await action; await duplicate;
  poll.resolve(snapshot({ phase: 'downloading', downloadedBytes: 30, totalBytes: 100 })); await settle();
  assert.equal(f.controller.state.update?.phase, 'verified');
  assert.equal(f.controller.state.pending, false);
  assert.equal(f.hasTimer(), false);
  f.controller.dispose();
});

test('operation polling exposes unknown download length and waiting; cancellation supersedes the install reply', async () => {
  const install = deferred<UpdateSnapshot>(); let reads = 0;
  const f = fixture((command) => command === 'install_update' ? install.promise : command === 'cancel_update' ? snapshot({ phase: 'verified' }) : snapshot({ automaticChecks: false, phase: ++reads > 1 ? 'waiting' : 'verified' }));
  await f.controller.start();
  const action = f.controller.install();
  await f.tick();
  assert.equal(f.controller.state.update?.phase, 'waiting');
  await f.controller.cancel();
  install.resolve(snapshot({ phase: 'restarting' })); await action;
  assert.equal(f.controller.state.update?.phase, 'verified');
  assert.equal(f.controller.state.pending, false);
  assert.deepEqual(f.calls.map(([command]) => command), ['update_state', 'install_update', 'update_state', 'cancel_update']);
  f.controller.dispose();
});

test('polls show native progress and stop at a terminal snapshot after recovering an active operation', async () => {
  let reads = 0;
  const f = fixture(() => ++reads === 1 ? snapshot({ automaticChecks: false, phase: 'downloading' }) : reads === 2 ? snapshot({ phase: 'downloading', downloadedBytes: 50 }) : snapshot({ phase: 'verified' }));
  await f.controller.start(); await f.tick();
  assert.equal(f.controller.state.update?.downloadedBytes, 50);
  assert.equal(f.controller.state.update?.totalBytes, null);
  await f.tick();
  assert.equal(f.controller.state.update?.phase, 'verified'); assert.equal(f.hasTimer(), false);
  f.controller.dispose();
});

test('manual retry sends only fixed arguments, hides rejected bridge details, and remembers the failed operation', async () => {
  let attempts = 0;
  const f = fixture((command) => { if (command === 'download_update' && ++attempts === 1) throw new Error('DO-NOT-PRINT secret path'); return snapshot({ automaticChecks: false, phase: command === 'download_update' ? 'verified' : 'available', availableVersion: '0.2.0' }); });
  await f.controller.start(); await f.controller.download();
  assert.equal(f.controller.state.retry, 'download'); assert.doesNotMatch(f.controller.state.detail, /DO-NOT-PRINT|secret/);
  await f.controller.retry(); assert.equal(f.controller.state.update?.phase, 'verified');
  await f.controller.check(); await f.controller.preferences(true);
  assert.deepEqual(f.calls, [['update_state', undefined], ['download_update', undefined], ['download_update', undefined], ['check_update', { automatic: false }], ['update_preferences', { automaticChecks: true }]]);
  f.controller.dispose();
});

test('browser, invalid phase actions and disposed callbacks cannot trigger or publish native work', async () => {
  const browser = new UpdateController(null);
  await browser.start(); await browser.check(); await browser.download(); await browser.install(); await browser.cancel(); await browser.preferences(true);
  assert.equal(browser.state.update, null); assert.equal(browser.state.native, false);
  const reply = deferred<UpdateSnapshot>();
  const f = fixture(() => reply.promise);
  let changes = 0; f.controller.subscribe(() => changes++);
  const action = f.controller.start(); f.controller.dispose(); const afterDispose = changes;
  reply.resolve(snapshot()); await action; await f.controller.check();
  assert.equal(changes, afterDispose); assert.equal(f.controller.state.update, null);
  assert.deepEqual(f.calls, [['update_state', undefined]]);
  const idle = fixture(() => snapshot({ automaticChecks: false })); await idle.controller.start(); await idle.controller.install(); await idle.controller.cancel();
  assert.deepEqual(idle.calls, [['update_state', undefined]]); idle.controller.dispose();
});

test('snapshot decoder rejects excess fields, oversized notes, invalid phases and impossible byte counters', () => {
  assert.equal(decodeUpdateSnapshot(snapshot()).installedVersion, '0.1.0');
  for (const fields of [{ path: '/tmp/secret' }, { generation: 1 }, { notes: 'a'.repeat(8193) }, { diagnostic: 'x'.repeat(513) }, { phase: 'ready' }, { installedVersion: '' }, { downloadedBytes: -1 }, { downloadedBytes: Infinity }, { totalBytes: 0, downloadedBytes: 1 }]) assert.throws(() => decodeUpdateSnapshot({ ...snapshot(), ...fields }));
});


test('a failed initial state read can retry without inventing an installed version', async () => {
  let attempts = 0;
  const f = fixture((command) => { if (command === 'update_state' && ++attempts === 1) throw new Error('offline'); return snapshot({ automaticChecks: false }); });
  await f.controller.start(); assert.equal(f.controller.state.update, null);
  await f.controller.retry();
  assert.equal(f.controller.snapshot().update?.installedVersion, '0.1.0');
  assert.deepEqual(f.calls, [['update_state', undefined], ['update_state', undefined], ['check_update', { automatic: false }]]);
  f.controller.dispose();
});

test('duplicate cancellation requests coalesce while other action requests stay serial', async () => {
  const cancel = deferred<UpdateSnapshot>();
  const f = fixture((command) => command === 'cancel_update' ? cancel.promise : snapshot({ automaticChecks: false, phase: 'downloading' }));
  await f.controller.start();
  const first = f.controller.cancel(); const second = f.controller.cancel();
  await f.controller.preferences(false); // Disabled during cancellation.
  assert.equal(f.calls.filter(([command]) => command === 'cancel_update').length, 1);
  cancel.resolve(snapshot({ phase: 'available', availableVersion: '0.2.0' })); await first; await second;
  assert.equal(f.controller.state.pending, false); f.controller.dispose();
});


test('default operation polling schedules reads and disposal clears the next read', async () => {
  const calls: UpdateCommand[] = [];
  const controller = new UpdateController({ invoke: async (command) => { calls.push(command); return snapshot({ automaticChecks: false, phase: 'downloading' }); } });
  await controller.start();
  assert.deepEqual(calls, ['update_state']);
  await new Promise((resolve) => setTimeout(resolve, 550)); assert.deepEqual(calls, ['update_state', 'update_state']);
  controller.dispose(); await new Promise((resolve) => setTimeout(resolve, 550)); assert.equal(calls.length, 2);
});

test('a native installation error offers only installation retry until its verified bytes are consumed', async () => {
  let attempts = 0;
  const f = fixture((command) => command === 'install_update' ? snapshot({ phase: ++attempts === 1 ? 'error' : 'restarting', diagnostic: attempts === 1 ? 'Install failed.' : null }) : snapshot({ phase: 'verified', automaticChecks: false }));
  await f.controller.start(); await f.controller.install();
  assert.equal(f.controller.state.retry, 'install'); await f.controller.retry();
  assert.equal(f.controller.state.update?.phase, 'restarting'); assert.equal(f.controller.state.retry, null);
  f.controller.dispose();
});
