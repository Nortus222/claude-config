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
    calls.push([command, args]); return { generation: 1, data: command === 'mcp_connections' ? await reply(args) : command === 'agent_status'
      ? { at: 'now', policy: 'notify', paused: null, trusted: true, pending: [], drift: [], conflicts: [], probeErrors: [], counts: { pending: 0, held: 0, ready: 0, drift: 0 } } : command === 'inspect_machine' ? { profile: { repo: '/fixture', revision: 'fixture', overrides: '/fixture/overrides', issues: [] }, items: [], probeErrors: [] } : null };
  } };
  const machine = new MachineController(bridge); const controller = new ConnectionsController(bridge, machine);
  return { machine, controller, calls };
}
test('settings distinguish configured registration, reload guidance and unobserved session; unmanaged routing offers copy text', async () => {
  const f = fixture(); await f.machine.connect(); await f.controller.refresh();
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
