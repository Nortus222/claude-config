import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeStartupContext } from '../shared/startup-protocol.ts';

const setup = { needsSetup: false, repo: '/fixture/repo', gitAvailable: true, canInstallGit: true,
  defaultRepoUrl: 'https://github.com/Nortus222/claude-config.git' };
const maintenance = { pending: false, phase: null, fromVersion: null, toVersion: null, backupPath: null, diagnostic: null };
const ready = { stateRoot: '/fixture/state', setup, maintenance, outcome: 'ready' };

test('startup context accepts exact authority results and refuses malformed or contradictory records', () => {
  assert.deepEqual(decodeStartupContext(ready), ready);
  for (const invalid of [null, [], { ...ready, env: { API_TOKEN: 'secret' } }, { ...ready, stateRoot: 'relative' },
    { ...ready, stateRoot: '/fixture/\nstate' }, { ...ready, stateRoot: '/fixture/\u0085state' },
    { ...ready, setup: { ...setup, repo: '/fixture/\u0085repo' } }, { ...ready, outcome: 'unknown' }, { ...ready, setup: null },
    { ...ready, setup: { ...setup, needsSetup: true } }, { ...ready, maintenance: { ...maintenance, pending: true } },
    { ...ready, maintenance: { ...maintenance, diagnostic: 'raw exception' } }, { ...ready, setup: { ...setup, extra: 1 } },
    { ...ready, setup: { ...setup, repo: ['not-a-path'] } }, { ...ready, maintenance: { ...maintenance, extra: true } }]) {
    assert.throws(() => decodeStartupContext(invalid));
  }
  const pending = { ...maintenance, pending: true, phase: 'awaiting-health', fromVersion: '0.1.2', toVersion: '0.1.3', backupPath: '/fixture/state/backups/app' };
  for (const outcome of ['recovered', 'recovery_failed']) assert.equal(decodeStartupContext({ ...ready, maintenance: pending, outcome }).outcome, outcome);
  assert.throws(() => decodeStartupContext({ ...ready, maintenance: pending, outcome: 'ready' }));
  assert.throws(() => decodeStartupContext({ ...ready, maintenance: { ...pending, toVersion: '0.1.1' }, outcome: 'recovered' }));
  assert.deepEqual(decodeStartupContext({ ...ready, setup: null, maintenance: null, outcome: 'setup_failed' }), { ...ready, setup: null, maintenance: null, outcome: 'setup_failed' });
  for (const outcome of ['runtime_failed', 'maintenance_failed']) assert.equal(decodeStartupContext({ ...ready, maintenance: null, outcome }).outcome, outcome);
  const firstRun = { ...setup, needsSetup: true, repo: null };
  assert.equal(decodeStartupContext({ ...ready, setup: firstRun, outcome: 'needs_setup' }).outcome, 'needs_setup');
  assert.equal(decodeStartupContext({ ...ready, setup: firstRun, maintenance: pending, outcome: 'needs_setup' }).outcome, 'needs_setup');
  assert.throws(() => decodeStartupContext({ ...ready, setup: firstRun, outcome: 'ensure_failed' }));
});
