import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { configDomain, HistoryStore, integrationsDomain, pathsFromEnvironment } from '@nortuscc/machine';
import { agentLayer, startAgent, trustOwnSetup, type AgentDomain } from '../src/index.ts';
import { accept, EFFORT, HEAD, HOOK, setupFixture } from './support/setup-fixture.ts';

test('done when: on an auto-apply machine an accepted inert key is applied with a backup, an accepted hook is held, and History shows both', async () => {
  // A temporary HOME, and a fixture setup repo whose head commit (the user's own checkout) adds an
  // inert settings key and a hook. #43 is not built, so SetupSource is the fixture's fake.
  const home = mkdtempSync(join(tmpdir(), 'agent-done-when-'));
  const fixture = setupFixture(join(home, 'src', 'claude-config'));
  const checkout = fixture.dirs[HEAD]!;
  spawnSync('git', ['init', '-q', checkout]);
  spawnSync('git', ['-C', checkout, 'remote', 'add', 'origin', 'git@github.com:Nortus222/claude-config.git']);
  const paths = await Effect.runPromise(pathsFromEnvironment({
    env: { APPDATA: join(home, 'AppData') }, home, platform: process.platform, fallbackRepo: checkout,
  }));
  const original = JSON.stringify({ theme: 'dark' }, null, 2) + '\n';
  mkdirSync(paths.claude, { recursive: true });
  writeFileSync(join(paths.claude, 'settings.json'), original);
  const domains: ReadonlyArray<AgentDomain> = [configDomain, integrationsDomain({ paths, env: {} })];

  const { status, events } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    // Installing the agent is the person's act that trusts this checkout.
    yield* trustOwnSetup('cli');
    const agent = yield* startAgent(() => domains);
    yield* agent.setPolicy('auto-apply', 'cli');
    yield* agent.decide(accept(EFFORT), 'app');
    const status = yield* agent.decide(accept(HOOK), 'app');
    return { status, events: yield* HistoryStore.use((h) => h.read) };
  })).pipe(Effect.provide(Layer.merge(agentLayer(paths), fixture.source))));

  // The inert key is applied, nothing else in settings.json moved, and the hook is not installed.
  assert.deepEqual(JSON.parse(readFileSync(join(paths.claude, 'settings.json'), 'utf8')), { theme: 'dark', effortLevel: 'high' });
  assert.equal(existsSync(join(paths.claude, 'hooks', 'session.mjs')), false);

  // History: one automatic run, finished, with the backup of the file it changed.
  const [run, ...otherRuns] = events.filter((e) => e.kind === 'apply-finished');
  assert.equal(otherRuns.length, 0);
  assert.ok(run?.kind === 'apply-finished');
  assert.deepEqual(run.steps.map((s) => [s.key, s.outcome]), [['config:claude:settings.json#effortLevel', 'ok']]);
  assert.equal(run.result, 'done');
  assert.ok(typeof run.backup === 'string' && run.backup.startsWith(paths.backups));
  assert.equal(readFileSync(join(run.backup, 'claude', 'settings.json'), 'utf8'), original);

  // History records both acceptances. Under the fake source (R21) accepting EFFORT alone already
  // makes HOOK pending, so these events, not the held verdict, show the hook's acceptance happened.
  assert.deepEqual(
    events.flatMap((e) => (e.kind === 'decided' ? [[e.itemId, e.decision]] : [])),
    [[EFFORT, 'accept'], [HOOK, 'accept']],
  );

  // The hook waits for a person on this machine.
  const [held, ...otherHeld] = events.filter((e) => e.kind === 'held');
  assert.equal(otherHeld.length, 0);
  assert.ok(held?.kind === 'held');
  assert.deepEqual(held.items, [{ itemId: HOOK, reason: 'integration' }]);
  assert.deepEqual(status.pending.filter((p) => p.verdict.kind === 'held').map((p) => p.itemId), [HOOK]);
  assert.equal(status.policy, 'auto-apply');
  assert.equal(status.paused, null);
  assert.ok(!events.some((e) => e.kind === 'paused'));

  // The machine trusts its own checkout, by normalized URL.
  const setups = JSON.parse(readFileSync(join(paths.stateRoot, 'agent', 'setups.json'), 'utf8'));
  assert.equal(setups.setups[0].repoUrl, 'github.com/nortus222/claude-config');
});
