import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { join } from 'node:path';
import * as agent from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';
import type { HostedState } from '@nortuscc/hosted-client';

const state: HostedState = { accountId: 'account1', login: 'person', machineId: 'machine1', auth: 'signed-in',
  setups: [{ setupId: 'setup1', name: 'Setup', repoUrl: 'https://github.com/example/setup.git', latestRevision: 1 }],
  machine: { policy: 'notify', reportStatus: true }, lastSyncAt: null, retryAt: null, pollAfter: 900, error: null };

test('hosted trust binds current offered account and actual matching own origin only', async () => {
  const m = agentMachine();
  assert.equal(typeof agent.trustHostedSetup, 'function');
  await m.run(agent.trustOwnSetup('cli'));
  await m.run(agent.trustHostedSetup('setup1', state, 'cli'));
  const entries = await m.run(agent.SetupsStore.use((s) => s.read));
  assert.equal(entries?.length, 1);
  assert.equal(entries?.[0]?.accountId, 'account1');
  assert.equal(entries?.[0]?.checkout, m.paths.repo);
  await assert.rejects(m.run(agent.trustHostedSetup('unknown', state, 'cli')), /invalid_request/);
  await assert.rejects(m.run(agent.trustHostedSetup('setup1', { ...state, setups: [{ ...state.setups[0]!, repoUrl: 'https://github.com/other/repo' }] }, 'cli')), /invalid_request/);
  assert.deepEqual(await m.run(agent.SetupsStore.use((s) => s.read)), entries);
});

test('different origin grants null-checkout consent, corruption and absent account write nothing', async () => {
  const m = agentMachine();
  assert.equal(typeof agent.trustHostedSetup, 'function');
  const other = { ...state, setups: [{ ...state.setups[0]!, repoUrl: 'https://github.com/other/repo' }] };
  const entry = await m.run(agent.trustHostedSetup('setup1', other, 'app'));
  assert.equal(entry.checkout, null);
  const path = join(m.paths.stateRoot, 'agent', 'setups.json');
  m.write(path, '{broken');
  await assert.rejects(m.run(agent.trustHostedSetup('setup1', state, 'cli')), /storage/);
  assert.equal(m.read(path), '{broken');
  await assert.rejects(m.run(agent.trustHostedSetup('setup1', { ...state, accountId: null }, 'cli')), /unauthenticated/);
  assert.equal(m.read(path), '{broken');
});
