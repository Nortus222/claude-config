import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureOwnSetup, normalizeRepoUrl, SetupsStore } from '../src/index.ts';
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

const setupsJson = (m: ReturnType<typeof agentMachine>) => join(m.paths.stateRoot, 'agent', 'setups.json');

test('the own checkout is trusted once, by its normalized origin URL', async () => {
  const m = agentMachine();
  mkdirSync(m.paths.repo, { recursive: true });
  spawnSync('git', ['init', '-q', m.paths.repo]);
  spawnSync('git', ['-C', m.paths.repo, 'remote', 'add', 'origin', 'git@github.com:Nortus222/Claude-Config.git']);
  const first = await m.run(ensureOwnSetup('cli'));
  const second = await m.run(ensureOwnSetup('cli'));
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
  const own = await m.run(ensureOwnSetup('agent'));
  assert.equal(own?.repoUrl, null);
  assert.deepEqual(await m.run(SetupsStore.use((s) => s.read)), [own]);
});

test('an unreadable setups.json trusts nothing and is left alone', async () => {
  const m = agentMachine();
  for (const text of ['{ broken', JSON.stringify({ version: 1, setups: [{ setupId: 3 }] })]) {
    m.write(setupsJson(m), text);
    assert.equal(await m.run(SetupsStore.use((s) => s.read)), undefined);
    assert.equal(await m.run(ensureOwnSetup('agent')), undefined);
    assert.equal(m.read(setupsJson(m)), text);
  }
  assert.deepEqual(await m.kinds(), []);
});
