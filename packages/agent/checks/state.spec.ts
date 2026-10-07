import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Effect } from 'effect';
import { AgentStateStore, changePolicy, DEFAULT_STATE, pause } from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';

const agentJsonPath = (m: ReturnType<typeof agentMachine>) => join(m.paths.stateRoot, 'agent', 'agent.json');

test('a machine with no agent.json is on notify by default, not paused', async () => {
  const m = agentMachine();
  assert.deepEqual(await m.run(AgentStateStore.use((s) => s.read)), { version: 1, policy: 'notify', policySource: 'default', paused: null });
  assert.deepEqual(DEFAULT_STATE, { version: 1, policy: 'notify', policySource: 'default', paused: null });
});

test('update keeps fields other issues own, such as installedBy', async () => {
  const m = agentMachine();
  m.write(agentJsonPath(m), JSON.stringify({ version: 1, policy: 'notify', policySource: 'default', paused: null, installedBy: 'app', agentVersion: '0.1.0' }));
  const next = await m.run(AgentStateStore.use((s) => s.update((state) => ({ ...state, policy: 'auto-apply', policySource: 'person' }))));
  assert.equal(next.policy, 'auto-apply');
  assert.deepEqual(m.agentJson(), {
    version: 1, policy: 'auto-apply', policySource: 'person', paused: null, installedBy: 'app', agentVersion: '0.1.0',
  });
});

test('a pause round-trips with its reason and run', async () => {
  const m = agentMachine();
  const paused = { reason: 'a step failed', at: '2026-10-06T12:00:00.000Z', runId: 'r1' };
  await m.run(AgentStateStore.use((s) => s.update((state) => ({ ...state, paused }))));
  assert.deepEqual((await m.run(AgentStateStore.use((s) => s.read))).paused, paused);
});

test('an unknown policy reads as notify, and a malformed pause still reads as paused', async () => {
  const m = agentMachine();
  m.write(agentJsonPath(m), JSON.stringify({ version: 1, policy: 'yolo', policySource: 'person', paused: true }));
  const state = await m.run(AgentStateStore.use((s) => s.read));
  assert.equal(state.policy, 'notify');
  assert.deepEqual(state.paused, { reason: 'paused', at: '' });
});

test('a corrupt agent.json reads as the default', async () => {
  const m = agentMachine();
  m.write(agentJsonPath(m), '{ broken');
  assert.deepEqual(await m.run(AgentStateStore.use((s) => s.read)), DEFAULT_STATE);
});

test('a pause survives a concurrent policy change', async () => {
  const m = agentMachine();
  for (let i = 0; i < 20; i++) {
    await m.run(AgentStateStore.use((s) => s.update((state) => ({ ...state, policy: 'notify', policySource: 'default', paused: null }))));
    await m.run(Effect.all([pause(`run ${i}`), changePolicy(i % 2 ? 'auto-apply' : 'manual', 'cli')], { concurrency: 'unbounded' }));
    const state = await m.run(AgentStateStore.use((s) => s.read));
    assert.equal(state.paused?.reason, `run ${i}`);
    assert.equal(state.policy, i % 2 ? 'auto-apply' : 'manual');
  }
});

test('installedBy and agentVersion round-trip through update and can be removed', async () => {
  const m = agentMachine();
  await m.run(AgentStateStore.use((s) => s.update((state) => ({ ...state, installedBy: 'cli', agentVersion: '0.2.0' }))));
  const read = await m.run(AgentStateStore.use((s) => s.read));
  assert.equal(read.installedBy, 'cli');
  assert.equal(read.agentVersion, '0.2.0');
  await m.run(AgentStateStore.use((s) => s.update(({ installedBy: _i, agentVersion: _v, ...rest }) => rest)));
  const after = await m.run(AgentStateStore.use((s) => s.read));
  assert.equal('installedBy' in after, false);
  assert.equal('agentVersion' in after, false);
  assert.equal('installedBy' in m.agentJson(), false);
  assert.equal('agentVersion' in m.agentJson(), false);
});

test('a malformed installedBy or agentVersion reads as absent', async () => {
  const m = agentMachine();
  m.write(agentJsonPath(m), JSON.stringify({ version: 1, policy: 'notify', policySource: 'default', paused: null, installedBy: 'robot', agentVersion: 3 }));
  const state = await m.run(AgentStateStore.use((s) => s.read));
  assert.equal('installedBy' in state, false);
  assert.equal('agentVersion' in state, false);
});

test('registered app path survives policy updates, validates absolute paths and can be removed', async () => {
  const m = agentMachine();
  await m.run(AgentStateStore.use((s) => s.update((state) => ({ ...state, installedBy: 'app', appPath: '/Applications/Test.app/Contents/MacOS/Test' }))));
  await m.run(changePolicy('manual', 'cli'));
  assert.equal((await m.run(AgentStateStore.use((s) => s.read))).appPath, '/Applications/Test.app/Contents/MacOS/Test');
  await m.run(AgentStateStore.use((s) => s.update(({ appPath: _p, ...rest }) => rest)));
  assert.equal('appPath' in m.agentJson(), false);
  m.write(agentJsonPath(m), JSON.stringify({ ...DEFAULT_STATE, appPath: 'relative/Test' }));
  assert.equal((await m.run(AgentStateStore.use((s) => s.read))).appPath, undefined);
});
