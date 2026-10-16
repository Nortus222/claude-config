import test from 'node:test';
import assert from 'node:assert/strict';
import { SetupController } from '../src/setup-controller.ts';
import { MachineController } from '../src/controller.ts';
import type { Bridge, Command } from '../src/bridge.ts';
import { DEFAULT_REPO_URL } from '../shared/setup-protocol.ts';
const setup = (fields = {}) => ({ needsSetup: true, repo: null, gitAvailable: false, canInstallGit: true, defaultRepoUrl: DEFAULT_REPO_URL, ...fields });
const hello = { agentVersion: 'fixture', protocol: 3, policy: 'notify', paused: null };
function fixture(handler: (command: Command, args?: Readonly<Record<string, unknown>>) => unknown) {
  const calls: Array<[Command, unknown]> = [];
  const bridge: Bridge = { subscribe: async () => () => {}, invoke: async (command, args) => {
    calls.push([command, args]); return { generation: 1, data: await handler(command, args) };
  } };
  const machine = new MachineController(bridge);
  return { calls, machine, controller: new SetupController(bridge, machine) };
}
test('new installation checks prerequisites before any agent connection and requires an explicit installer action', async () => {
  let installed = false;
  const f = fixture((command) => command === 'desktop_setup_state' ? setup({ gitAvailable: installed }) : command === 'install_git' ? (installed = true, { requested: true }) : null);
  await f.controller.check();
  assert.equal(f.controller.state.phase, 'needed');
  assert.deepEqual(f.calls.map(([command]) => command), ['desktop_setup_state']);
  await f.controller.installGit();
  assert.match(f.controller.state.detail, /Apple.*dialog/);
  await f.controller.check();
  assert.equal(f.controller.state.setup?.gitAvailable, true);
});
test('existing setup opens inspection without sending target choices or bootstrap', async () => {
  const f = fixture((command) => command === 'desktop_setup_state' ? setup({ needsSetup: false, repo: '/existing' }) : null);
  f.controller.choose([]);
  await f.controller.check();
  assert.equal(f.controller.state.phase, 'ready');
  assert.equal(f.calls.some(([command]) => command === 'setup_desktop'), false);
});
test('failed registration retries the fixed bootstrap with the preserved picker and validates native hello', async () => {
  let attempts = 0;
  const f = fixture((command) => command === 'desktop_setup_state' ? setup({ gitAvailable: true }) : command === 'setup_desktop' ? (++attempts === 1 ? Promise.reject(new Error('secret fixture')) : { hello }) : null);
  await f.controller.check();
  f.controller.choose([]);
  await f.controller.bootstrap();
  assert.equal(f.controller.state.phase, 'needed');
  assert.doesNotMatch(f.controller.state.detail, /secret/);
  await f.controller.bootstrap();
  assert.equal(f.controller.state.phase, 'ready');
  assert.deepEqual(f.calls.filter(([command]) => command === 'setup_desktop').map(([, args]) => args), [{ configTargets: [] }, { configTargets: [] }]);
});
test('malformed setup, installer and hello replies remain bounded errors with no rejected values', async () => {
  for (const target of ['desktop_setup_state', 'install_git', 'setup_desktop']) {
    const f = fixture((command) => command === target ? { ...setup({ gitAvailable: target === 'setup_desktop' }), token: 'DO-NOT-PRINT' } : command === 'desktop_setup_state' ? setup({ gitAvailable: target === 'setup_desktop' }) : null);
    await f.controller.check();
    if (target === 'install_git') await f.controller.installGit();
    if (target === 'setup_desktop') await f.controller.bootstrap();
    assert.doesNotMatch(f.controller.state.detail, /DO-NOT-PRINT|token/);
    assert.notEqual(f.controller.state.phase, 'ready');
  }
});
test('browser preview and disposed setup never invoke native actions or accept late replies', async () => {
  const browser = new SetupController(null, new MachineController(null));
  await browser.check(); await browser.installGit(); await browser.bootstrap();
  assert.equal(browser.state.phase, 'browser');
  let resolve!: (value: unknown) => void;
  const f = fixture(() => new Promise((r) => { resolve = r; }));
  const check = f.controller.check(); f.controller.dispose(); resolve(setup()); await check;
  assert.equal(f.controller.state.setup, null);
});
test('first-run choices and native mutations require a validated setup-needed state', async () => {
  let broken = false;
  const f = fixture((command) => command === 'desktop_setup_state' ? broken ? { invalid: true } : setup({ needsSetup: false, repo: '/existing', gitAvailable: true }) : null);
  f.controller.choose([]);
  await f.controller.bootstrap(); await f.controller.installGit();
  assert.deepEqual(f.controller.state.configTargets, ['claude', 'codex']);
  assert.equal(f.calls.length, 0);
  await f.controller.check();
  broken = true;
  await f.controller.check();
  assert.equal(f.controller.state.phase, 'error');
  assert.equal(f.controller.state.setup?.repo, '/existing');
  const calls = f.calls.length;
  f.controller.choose([]);
  await f.controller.bootstrap(); await f.controller.installGit();
  assert.deepEqual(f.controller.state.configTargets, ['claude', 'codex']);
  assert.equal(f.calls.length, calls);
});
test('successful first-run bootstrap followed by a connection failure cannot offer bootstrap again', async () => {
  const f = fixture((command) => command === 'desktop_setup_state' ? setup({ gitAvailable: true })
    : command === 'setup_desktop' ? { hello }
    : command === 'agent_generation' ? Promise.reject(new Error('CLOSED: agent exited')) : null);
  await f.controller.check();
  await f.controller.bootstrap();
  assert.equal(f.controller.state.phase, 'ready');
  assert.equal(f.machine.state.connection, 'disconnected');
  await f.controller.bootstrap();
  assert.equal(f.calls.filter(([command]) => command === 'setup_desktop').length, 1);
});
test('only a first-run bootstrap completed in this session marks the setup bootstrapped', async () => {
  const existing = fixture((command) => command === 'desktop_setup_state' ? setup({ needsSetup: false, repo: '/existing' }) : null);
  assert.equal(existing.controller.state.bootstrapped, false);
  await existing.controller.check();
  assert.equal(existing.controller.state.bootstrapped, false);
  let attempts = 0;
  const f = fixture((command) => command === 'desktop_setup_state' ? setup({ gitAvailable: true })
    : command === 'setup_desktop' ? (++attempts === 1 ? Promise.reject(new Error('fixture')) : { hello }) : null);
  await f.controller.check();
  await f.controller.bootstrap();
  assert.equal(f.controller.state.bootstrapped, false);
  await f.controller.bootstrap();
  assert.equal(f.controller.state.bootstrapped, true);
  await f.controller.check();
  assert.equal(f.controller.state.bootstrapped, true);
});
