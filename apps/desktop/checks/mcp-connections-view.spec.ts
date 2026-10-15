import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionsController } from '../src/mcp-connections-controller.ts';
import { ConnectionsView } from '../src/mcp-connections-view.tsx';
import { MachineController } from '../src/controller.ts';
import type { Bridge, Command } from '../src/bridge.ts';
import { decodeConnectionAction, decodeConnections, type ConnectionResult } from '../shared/mcp-connections-protocol.ts';
const item: ConnectionResult = { target: 'codex', registration: 'configured', routing: { status: 'unmanaged', intent: 'unowned', blockStatus: 'absent', offeredText: 'Use nortuscc tools.' }, session: 'unobserved', reload: 'recommended', observation: 'local-registration', note: '' };
function fixture(reply: (args: unknown) => unknown = () => ({ connections: [item] })) {
  const calls: Array<[Command, unknown]> = [];
  const bridge: Bridge = { subscribe: async () => () => {}, invoke: async (command, args) => {
    assert.ok(['mcp_connections', 'agent_generation', 'take_review_request', 'agent_status', 'inspect_machine'].includes(command), `Unfaked command: ${command}`);
    calls.push([command, args]); return { generation: 1, data: command === 'mcp_connections' ? await reply(args) : command === 'agent_status'
      ? { at: 'now', policy: 'notify', paused: null, trusted: true, pending: [], drift: [], conflicts: [], probeErrors: [], counts: { pending: 0, held: 0, ready: 0, drift: 0 } } : command === 'inspect_machine' ? { profile: { repo: '/fixture', revision: 'fixture', overrides: '/fixture/overrides', issues: [] }, items: [], probeErrors: [] } : null };
  } };
  const machine = new MachineController(bridge); const controller = new ConnectionsController(bridge, machine);
  return { machine, controller, calls };
}
test('settings distinguish configured registration, reload guidance and unobserved session; unmanaged routing offers copy text', async () => {
  const f = fixture(args => ({ connections: (args as { action: string }).action === 'inspect' ? [item, { ...item, target: 'claude', registration: 'absent' }] : [{ ...item, target: 'claude' }] })); await f.machine.connect(); await f.controller.refresh();
  const html = renderToStaticMarkup(createElement(ConnectionsView, { state: f.controller.state, controller: f.controller }));
  assert.match(html, /Configured/); assert.match(html, /Reload needed for existing sessions/);
  assert.match(html, /Host session: not observed/); assert.match(html, /Copy guidance/);
  assert.match(html, /Use nortuscc tools/); assert.doesNotMatch(html, /Connected to Codex/);
  await f.controller.connect('claude');
  assert.deepEqual(f.calls.filter(c => c[0] === 'mcp_connections').at(-1)?.[1], { action: 'connect', target: 'claude' });
});
test('renderer protocol refuses arbitrary paths, commands and unproven connected claims', () => {
  for (const value of [{ action: 'connect', target: 'codex', appPath: '/foreign' }, { action: 'connect', target: 'shell' }, { action: 'inspect', command: 'run' }]) assert.throws(() => decodeConnectionAction(value));
  assert.throws(() => decodeConnections({ connections: [{ ...item, session: 'connected' }] }));
  assert.throws(() => decodeConnections({ connections: [{ ...item, secret: 'private' }] }));
});
test('late and malformed helper replies cannot repopulate settings or expose raw output', async () => {
  let resolve!: (v: unknown) => void;
  const f = fixture(() => new Promise(r => { resolve = r; })); await f.machine.connect();
  const request = f.controller.refresh(); await Promise.resolve(); f.controller.dispose(); resolve({ connections: [item] }); await request;
  assert.equal(f.controller.state.connections.length, 0);
  const bad = fixture(() => { throw new Error('SECRET native output'); }); await bad.machine.connect(); await bad.controller.refresh();
  assert.doesNotMatch(bad.controller.state.detail, /SECRET/);
});

for (const status of ['released', 'unmanaged'] as const) test(`absent registration with ${status} retained routing offers a fixed disconnect retry`, async () => {
  const retained: ConnectionResult = { ...item, registration: 'absent', routing: { status, intent: 'released', blockStatus: 'present', offeredText: '' } };
  const f = fixture(() => ({ connections: [retained] })); await f.machine.connect(); await f.controller.refresh();
  const html = renderToStaticMarkup(createElement(ConnectionsView, { state: f.controller.state, controller: f.controller })).match(/<article\b[^>]*>.*?<\/article>/)![0];
  assert.match(html, /remove the retained app guidance/); assert.match(html, /Instruction cleanup is incomplete/);
  assert.match(html, /<button[^>]*>Retry cleanup<\/button>/);
  await f.controller.disconnect('codex');
  assert.deepEqual(f.calls.filter(c => c[0] === 'mcp_connections').at(-1)?.[1], { action: 'disconnect', target: 'codex' });
  assert.equal(f.calls.some(([, args]) => (args as { action?: string } | undefined)?.action === 'connect'), false);
});

test('absent registration can retire active missing guidance but completed and unowned cleanup stay idle', async () => {
  for (const [intent, blockStatus, status, retry] of [
    ['active', 'absent', 'missing', true], ['released', 'absent', 'released', false],
    ['unowned', 'present', 'conflict', false], ['invalid', 'conflict', 'conflict', false],
  ] as const) {
    const f = fixture(() => ({ connections: [{ ...item, registration: 'absent', routing: { intent, blockStatus, status, offeredText: '' } }] }));
    await f.machine.connect(); await f.controller.refresh();
    const html = renderToStaticMarkup(createElement(ConnectionsView, { state: f.controller.state, controller: f.controller })).match(/<article\b[^>]*>.*?<\/article>/)![0];
    if (retry) {
      assert.match(html, /<button[^>]*>Retry cleanup<\/button>/);
      await f.controller.disconnect('codex');
      assert.deepEqual(f.calls.filter(c => c[0] === 'mcp_connections').at(-1)?.[1], { action: 'disconnect', target: 'codex' });
    }
    else { assert.doesNotMatch(html, /Retry cleanup|>Disconnect<\/button>/); }
  }
});

const markup = (f: ReturnType<typeof fixture>) => renderToStaticMarkup(createElement(ConnectionsView, { state: f.controller.state, controller: f.controller }));
const hostRow = (html: string, target: string) => html.match(new RegExp(`<article[^>]*aria-label="${target}"[^>]*>[\\s\\S]*?</article>`))![0];

test('unknown rows require inspection and pending feedback names only the requested host action', async () => {
  let finish!: (value: unknown) => void;
  const f = fixture(args => (args as { action: string }).action === 'inspect' ? { connections: [item] } : new Promise(resolve => { finish = resolve; }));
  await f.machine.connect();
  assert.doesNotMatch(markup(f), /<button[^>]*>(Connect|Repair|Disconnect)<\/button>/);
  await f.controller.refresh();
  const request = f.controller.disconnect('codex'); await Promise.resolve();
  assert.match(hostRow(markup(f), 'Codex'), /Disconnecting/);
  assert.doesNotMatch(hostRow(markup(f), 'Claude Code'), /Disconnecting/);
  assert.equal(f.controller.state.connections[0]?.registration, 'configured', 'no optimistic registration change');
  finish({ connections: [{ ...item, registration: 'absent' }] }); await request;
  assert.equal(f.controller.state.pending, false);
});

test('failed reads retain observations as unverified and block changes until inspection succeeds', async () => {
  let fail = false;
  const f = fixture(() => { if (fail) throw Error('SECRET'); return { connections: [item] }; });
  await f.machine.connect(); await f.controller.refresh(); fail = true; await f.controller.refresh();
  assert.equal(f.controller.state.connections[0]?.registration, 'configured');
  assert.match(f.controller.state.detail, /Couldn't check connections/); assert.match(markup(f), /role="alert"/);
  assert.match(hostRow(markup(f), 'Codex'), /Unverified/);
  const before = f.calls.length; await f.controller.disconnect('codex'); assert.equal(f.calls.length, before);
  assert.doesNotMatch(markup(f), /SECRET/);
  fail = false; await f.controller.refresh(); await f.controller.disconnect('codex');
  assert.equal(f.calls.at(-1)?.[0], 'mcp_connections');
  assert.deepEqual(f.calls.at(-1)?.[1], { action: 'disconnect', target: 'codex' });
});

for (const action of ['connect', 'disconnect'] as const) test(`failed ${action} is unconfirmed, redacted and cannot be repeated before checking`, async () => {
  const f = fixture(args => { if ((args as { action: string }).action !== 'inspect') throw Error('SECRET'); return { connections: [item] }; });
  await f.machine.connect(); await f.controller.refresh(); await f.controller[action]('codex');
  assert.match(f.controller.state.detail, /Couldn't confirm.*Codex/); assert.match(markup(f), /may have changed/);
  assert.doesNotMatch(markup(f), /SECRET/);
  const before = f.calls.length; await f.controller[action]('codex'); assert.equal(f.calls.length, before);
});

test('a new machine session drops an active action and ignores its late reply', async () => {
  let finish!: (value: unknown) => void;
  let delayed = false;
  const f = fixture(() => delayed ? new Promise(resolve => { finish = resolve; }) : { connections: [item] });
  await f.machine.connect(); await f.controller.refresh(); delayed = true;
  const request = f.controller.disconnect('codex'); await Promise.resolve();
  await f.machine.connect(); finish({ connections: [item] }); await request;
  assert.equal(f.controller.state.connections.length, 0);
  assert.equal(f.controller.state.pending, false); assert.equal(f.controller.state.detail, '');
});

test('context actions preserve ownership recovery while guidance states are explained in details', async () => {
  for (const status of ['installed', 'missing', 'unmanaged', 'conflict', 'unavailable'] as const) {
    const f = fixture(() => ({ connections: [{ ...item, routing: { ...item.routing, status } }] }));
    await f.machine.connect(); await f.controller.refresh();
    const row = hostRow(markup(f), 'Codex');
    assert.match(row, /<details/); assert.match(row, /Connection details/);
    if (status === 'missing') { assert.match(row, />Repair<\/button>/); assert.match(row.split('<details')[0]!, /Repair needed/); }
    if (status === 'unmanaged') assert.match(row, /Copy guidance/);
    if (status === 'conflict') assert.match(row.split('<details')[0]!, /edited|changed/);
    if (status === 'unavailable') assert.match(row.split('<details')[0]!, /guidance.*could not be checked/i);
  }
  const f = fixture(() => ({ connections: [{ ...item, registration: 'conflict' }] }));
  await f.machine.connect(); await f.controller.refresh();
  const row = hostRow(markup(f), 'Codex');
  assert.match(row, /<details[\s\S]*<button[^>]*>Disconnect<\/button>/);
  assert.doesNotMatch(row, /<button[^>]*>Connect<\/button>/);
});

test('initial inspection exposes checking state while all mutation actions remain disabled', async () => {
  let finish!: (value: unknown) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  await f.machine.connect(); const request = f.controller.refresh(); await Promise.resolve();
  assert.match(markup(f), /aria-busy="true"/);
  for (const name of ['Codex', 'Claude Code']) assert.match(hostRow(markup(f), name), /Checking/);
  const before = f.calls.length; await f.controller.connect('codex'); assert.equal(f.calls.length, before);
  finish({ connections: [item] }); await request;
});

for (const [kind, response] of [
  ['duplicate hosts', { connections: [item, item] }],
  ['wrong host', { connections: [{ ...item, target: 'claude' }] }],
  ['private fields', { connections: [{ ...item, note: 'SECRET', secret: 'SECRET' }] }],
] as const) test(`mutation reply with ${kind} preserves the previous observation and requires a fresh check`, async () => {
  const f = fixture(args => (args as { action: string }).action === 'inspect' ? { connections: [item] } : response);
  await f.machine.connect(); await f.controller.refresh(); await f.controller.disconnect('codex');
  assert.equal(f.controller.state.connections[0]?.target, 'codex');
  assert.equal(f.controller.state.connections[0]?.registration, 'configured');
  assert.match(hostRow(markup(f), 'Codex'), /Unverified/);
  assert.doesNotMatch(markup(f), /SECRET/);
});

test('reconnecting clears an earlier failed action instead of carrying its recovery message into a new session', async () => {
  const f = fixture(() => { throw Error('SECRET'); });
  await f.machine.connect(); await f.controller.refresh(); assert.notEqual(f.controller.state.detail, '');
  await f.machine.connect();
  assert.equal(f.controller.state.detail, ''); assert.equal(f.controller.state.connections.length, 0);
});
