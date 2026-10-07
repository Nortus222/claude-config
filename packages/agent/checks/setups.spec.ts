import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Effect, Layer } from 'effect';
import { Processes } from '@nortuscc/machine';
import { join } from 'node:path';
import { normalizeRepoUrl, SetupsStore, trustOwnSetup } from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';

const rows: ReadonlyArray<readonly [string, string]> = [
  ['git@github.com:Nortus222/Claude-Config.git', 'github.com/nortus222/claude-config'],
  ['https://user:token@GitHub.com/Nortus222/claude-config.git', 'github.com/nortus222/claude-config'],
  ['https://github.com/Nortus222/claude-config/', 'github.com/nortus222/claude-config'],
  ['ssh://git@github.com:22/Nortus222/claude-config.git', 'github.com/nortus222/claude-config'],
  ['github.com/nortus222/claude-config', 'github.com/nortus222/claude-config'],
  ['/Users/Me/src/Claude-Config.git', '/Users/Me/src/Claude-Config'],
  ['file:///Users/Me/src/Claude-Config/', '/Users/Me/src/Claude-Config'],
];

for (const [url, normalized] of rows) {
  test(`normalizeRepoUrl: ${url}`, () => {
    assert.equal(normalizeRepoUrl(url), normalized);
  });
}

for (const url of ['https://[bad/x', 'file:///Users/Me/%ZZ']) {
  test(`normalizeRepoUrl: a malformed ${url} is an unknown URL, not a defect`, () => {
    assert.equal(normalizeRepoUrl(url), null);
  });
}

const setupsJson = (m: ReturnType<typeof agentMachine>) => join(m.paths.stateRoot, 'agent', 'setups.json');

test('the own checkout is trusted once, by its normalized origin URL', async () => {
  const m = agentMachine();
  spawnSync('git', ['-C', m.paths.repo, 'remote', 'set-url', 'origin', 'git@github.com:Nortus222/Claude-Config.git']);
  const first = await m.run(trustOwnSetup('cli'));
  const second = await m.run(trustOwnSetup('cli'));
  assert.deepEqual(second, first);
  assert.equal(first?.setupId, null);
  assert.equal(first?.repoUrl, 'github.com/nortus222/claude-config');
  assert.equal(first?.checkout, m.paths.repo);
  assert.equal(JSON.parse(m.read(setupsJson(m))!).setups.length, 1);
  const events = await m.events();
  assert.deepEqual(events.map((e) => e.kind), ['setup-trusted']);
  assert.ok(events[0]?.kind === 'setup-trusted');
  assert.equal(events[0].repoUrl, 'github.com/nortus222/claude-config');
});

test('a checkout with no origin is trusted with repoUrl null', async () => {
  const m = agentMachine();
  // git's answer for a checkout with no origin, without its message on the test's stderr.
  const noOrigin = Layer.succeed(Processes, { run: () => Effect.succeed({ code: 2, stdout: '' }) });
  const own = await m.run(trustOwnSetup('agent').pipe(Effect.provide(noOrigin)));
  assert.equal(own?.repoUrl, null);
  assert.deepEqual(await m.run(SetupsStore.use((s) => s.read)), [own]);
});

test('an unreadable setups.json trusts nothing and is left alone', async () => {
  const m = agentMachine();
  for (const text of ['{ broken', JSON.stringify({ version: 1, setups: [{ setupId: 3 }] })]) {
    m.write(setupsJson(m), text);
    assert.equal(await m.run(SetupsStore.use((s) => s.read)), undefined);
    assert.equal(await m.run(trustOwnSetup('agent')), undefined);
    assert.equal(m.read(setupsJson(m)), text);
  }
  assert.deepEqual(await m.kinds(), []);
});

test('trusting this checkout replaces an own entry for another checkout', async () => {
  const m = agentMachine();
  const other = { setupId: null, repoUrl: 'github.com/example/setup', checkout: join(m.root, 'elsewhere'), trustedAt: '2026-10-01T00:00:00.000Z' };
  await m.run(SetupsStore.use((s) => s.write([other])));
  const own = await m.run(trustOwnSetup('cli'));
  assert.equal(own?.checkout, m.paths.repo);
  assert.deepEqual(await m.run(SetupsStore.use((s) => s.read)), [own]);
  assert.deepEqual(await m.kinds(), ['setup-trusted']);
});

test('trusting again after the origin changed records the new repository', async () => {
  const m = agentMachine();
  await m.run(trustOwnSetup('cli'));
  spawnSync('git', ['-C', m.paths.repo, 'remote', 'set-url', 'origin', 'https://github.com/example/moved.git']);
  const own = await m.run(trustOwnSetup('cli'));
  assert.equal(own?.repoUrl, 'github.com/example/moved');
  assert.deepEqual(await m.run(SetupsStore.use((s) => s.read)), [own]);
  assert.deepEqual(await m.kinds(), ['setup-trusted', 'setup-trusted']);
});

test('reinstall preserves linked own identity and account binding, origin change releases it', async () => {
  const m = agentMachine();
  const linked = { setupId: 'hosted-1', accountId: 'account-1', repoUrl: 'github.com/example/setup', checkout: m.paths.repo, trustedAt: '2026-10-01T00:00:00Z' };
  await m.run(SetupsStore.use((s) => s.write([linked])));
  assert.deepEqual(await m.run(trustOwnSetup('cli')), linked);
  assert.deepEqual(await m.run(SetupsStore.use((s) => s.read)), [linked]);
  assert.deepEqual(await m.kinds(), []);
  spawnSync('git', ['-C', m.paths.repo, 'remote', 'set-url', 'origin', 'https://github.com/example/new.git']);
  const replacement = await m.run(trustOwnSetup('cli'));
  assert.equal(replacement?.setupId, null);
  assert.equal(replacement?.accountId, undefined);
  assert.deepEqual(await m.run(SetupsStore.use((s) => s.read)), [replacement]);
});

test('malformed account binding makes the entire trust file unreadable', async () => {
  const m = agentMachine();
  m.write(setupsJson(m), JSON.stringify({ version: 1, setups: [{ setupId: 'hosted-1', accountId: 1, repoUrl: 'github.com/example/setup', checkout: m.paths.repo, trustedAt: '2026-10-01T00:00:00Z' }] }));
  assert.equal(await m.run(SetupsStore.use((s) => s.read)), undefined);
});
