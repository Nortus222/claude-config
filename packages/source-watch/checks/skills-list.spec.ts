import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { Fs, LaunchFailed, Processes, SKILLS_CLI_VERSION, additionCommand, nodeFs, type Command } from '@nortuscc/machine';
import { DISCOVERY_LIMITS, SKILL_TEXT_MAX_BYTES, discoverSkills, parseSkillsList, readSkillContents } from '../src/skills-list.ts';
import { Git, GitFailed, nodeGit } from '../src/git.ts';
import { SourceCleanupFailed } from '../src/services.ts';
import { watchUpstreamWithServices } from '../src/upstream.ts';
import { makeRepo, tempDir } from './fixtures.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/skills-list/${name}.txt`, import.meta.url), 'utf8');
const source = 'example/skills';
const commit = 'a'.repeat(40);
const remote = (sha = commit) => `ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n`;
const unavailable = (reason: string) => ({ kind: 'unavailable', source, reason });
const expectedOne = [{ name: 'first', description: 'First description.' }];

// These expected records were transcribed from the captured CLI output.
test('parses every skill name and description from a real listing', () => {
  const result = parseSkillsList(fixture('superpowers'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.skills.map(s => s.name), [
    'brainstorming', 'diagnosing-superpowers', 'dispatching-parallel-agents', 'executing-plans',
    'finishing-a-development-branch', 'receiving-code-review', 'requesting-code-review',
    'subagent-driven-development', 'systematic-debugging', 'test-driven-development',
    'using-git-worktrees', 'using-superpowers', 'verification-before-completion', 'writing-plans', 'writing-skills',
  ]);
  assert.deepEqual(result.skills.map(s => s.description), [
    'You MUST use this before any creative work - creating features, building components, adding functionality, modifying behavior, or planning anything new, in software or out of it (a talk, a business, a renovation).',
    'Use when a superpowers session went wrong and your human partner wants to know why — repeated work, ignored plans, stumbles, poor results, a skill that didn\'t fire, "it took too long", "why is it so expensive", "what is it doing" — or wants to build a bug report for the superpowers maintainers, for the current session or a past one identified by id or path, on any harness.',
    'Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies',
    'Use when executing an implementation plan in the current session as the implementer yourself — your human partner chose inline execution, or no subagent tool is available',
    'Use when implementation is complete, all tests pass, and you need to decide how to integrate the work',
    'Use when receiving code review feedback, before implementing suggestions, especially if feedback seems unclear or technically questionable - requires technical rigor and verification, not performative agreement or blind implementation',
    'Use when completing tasks, implementing major features, or before merging to verify work meets requirements',
    'Use when executing implementation plans with independent tasks in the current session',
    'Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes',
    'Use when implementing any feature or bugfix, before writing implementation code',
    'Use when starting feature work that needs isolation from current workspace or before executing implementation plans - ensures an isolated workspace exists via native tools or git worktree fallback',
    'Use when starting any conversation - establishes how to find and use skills, requiring skill invocation before ANY response including clarifying questions',
    'Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always',
    'Use when you have a spec or requirements for a multi-step task, before touching code',
    'Use when creating new skills, editing existing skills, or verifying skills work before deployment',
  ]);
});

test('parses the raw grouped capture including its ANSI cursor and spinner sequences', () => {
  const raw = fixture('mattpocock');
  assert.ok(raw.includes('\x1b['));
  const result = parseSkillsList(raw);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.skills.map(s => s.name), [
    'ask-matt', 'code-review', 'codebase-design', 'diagnosing-bugs', 'domain-modeling', 'grill-with-docs',
    'implement', 'implement-spec', 'improve-codebase-architecture', 'pr', 'prototype', 'research', 'retro',
    'setup-matt-pocock-skills', 'tdd', 'to-spec', 'to-tickets', 'triage', 'wayfinder', 'wizard', 'grill-me',
    'grilling', 'handoff', 'teach', 'to-questionnaire', 'wait-what', 'writing-for-agents', 'chief-of-staff',
    'claude-handoff', 'loop-me', 'setup-ts-deep-modules', 'writing-beats', 'writing-fragments', 'writing-shape',
    'git-guardrails-claude-code', 'migrate-to-shoehorn', 'scaffold-exercises', 'setup-pre-commit',
  ]);
  assert.equal(result.skills[0]?.description, 'Ask which skill or flow fits your situation. A router over the skills in this repo.');
  assert.ok(result.skills.every(s => s.description.length > 0 && !s.description.includes('\x1b')));
});

test('accepts one group, several groups, singular counts and wrapped Unicode descriptions', () => {
  assert.deepEqual(parseSkillsList(fixture('singular')), { ok: true, skills: expectedOne });
  assert.deepEqual(parseSkillsList(fixture('one-group')), { ok: true, skills: [
    ...expectedOne, { name: 'second', description: 'A Unicode description with café and 日本語.' },
  ] });
  assert.deepEqual(parseSkillsList(fixture('several-groups')), { ok: true, skills: [
    ...expectedOne, { name: 'second', description: 'Second description.' }, { name: 'third', description: 'Third description.' },
  ] });
  assert.deepEqual(parseSkillsList(fixture('wrapped')), { ok: true, skills: [
    { name: 'first', description: 'A long description that wraps onto another line with café.' },
  ] });
});

test('accepts the pinned CLI intro and noninteractive tip when agent detection is absent', () => {
  const intro = '┌   skills \n│\n│  Tip: use the --yes (-y) and --global (-g) flags to install without prompts.\n';
  assert.deepEqual(parseSkillsList(intro + fixture('singular')), { ok: true, skills: expectedOne });
});

test('a listing whose count disagrees with its records is unparseable', () => {
  assert.deepEqual(parseSkillsList(fixture('singular').replace('Found 1 skill', 'Found 2 skills')), { ok: false });
});

test('an unknown line makes the listing unparseable', () => {
  assert.deepEqual(parseSkillsList(fixture('unknown-line')), { ok: false });
  assert.deepEqual(parseSkillsList(`${fixture('singular')}unexpected trailing output\n`), { ok: false });
});

test('duplicate names, missing descriptions, missing envelope lines and truncation are unparseable', () => {
  const text = fixture('one-group');
  for (const bad of [
    text.replace('│    second', '│    first'), text.replace('│      First description.\n', ''),
    text.replace('◇  Available Skills', ''), text.replace('◇  Found 2 skills', ''),
    text.replace('◇  Source: https://github.com/example/skills.git', ''),
    text.slice(0, text.indexOf('└')), text.replace('Example Skills', 'Example Skills\nEmpty Group'),
  ]) assert.deepEqual(parseSkillsList(bad), { ok: false });
});

const fakeDiscovery = (t: Parameters<typeof tempDir>[0], run?: (command: Command) => ReturnType<InstanceType<typeof Processes>['run']>) => {
  const root = tempDir(t);
  const commands: Command[] = [];
  const layer = Layer.succeed(Processes, { run: command => {
    commands.push(command);
    return run?.(command) ?? Effect.succeed({ code: 0, stdout: command.cmd === 'git' ? remote() : fixture('singular'), stderr: 'npm notice' });
  } });
  return { root, commands, effect: discoverSkills(source, { tempDir: root }).pipe(Effect.provide(layer)) };
};

test('discovery runs the installer\'s pinned skills version with an isolated environment and removes its HOME', async t => {
  const f = fakeDiscovery(t, command => {
    assert.ok(existsSync(command.env!.HOME));
    assert.equal(command.cwd, command.env!.HOME);
    assert.deepEqual(command.envAllow, ['PATH', 'SystemRoot', 'WINDIR']);
    assert.equal(command.env?.TMPDIR, command.env?.HOME);
    assert.equal(command.env?.NO_COLOR, '1');
    assert.equal(command.env?.FORCE_COLOR, '0');
    assert.equal(command.env?.DISABLE_TELEMETRY, '1');
    assert.equal(command.env?.CODEX_HOME, undefined);
    assert.equal(command.env?.CLAUDE_CONFIG_DIR, undefined);
    assert.deepEqual(command.captureLimit, { stdout: 1_048_576, stderr: 16_384 });
    return Effect.succeed({ code: 0, stdout: command.cmd === 'git' ? remote() : fixture('singular') });
  });
  assert.deepEqual(await Effect.runPromise(f.effect), { kind: 'complete', source, commit, skills: expectedOne });
  assert.deepEqual(f.commands.map(c => [c.cmd, c.args]), [
    ['git', ['ls-remote', '--symref', '--', 'https://github.com/example/skills.git', 'HEAD']],
    ['npx', ['-y', `skills@${SKILLS_CLI_VERSION}`, 'add', '--', source, '--list', '--full-depth']],
    ['git', ['ls-remote', '--symref', '--', 'https://github.com/example/skills.git', 'HEAD']],
  ]);
  const install = additionCommand({ source, revision: commit, selectorName: 'first', targets: ['codex'] });
  assert.equal(install.args[1], f.commands[1]?.args[1]);
  assert.equal(f.commands[1]?.env?.SKILLS_CLONE_TIMEOUT_MS, '60000');
  assert.deepEqual(readdirSync(f.root), []);
});

test('HEAD moving during discovery reports head-moved', async t => {
  let reads = 0;
  const f = fakeDiscovery(t, command => Effect.succeed({ code: 0,
    stdout: command.cmd === 'git' ? remote(++reads === 1 ? commit : 'b'.repeat(40)) : fixture('singular'),
  }));
  assert.deepEqual(await Effect.runPromise(f.effect), unavailable('head-moved'));
  assert.deepEqual(readdirSync(f.root), []);
});

test('a timeout is unavailable and waits for process cleanup before removing HOME', async t => {
  const root = tempDir(t);
  let home = '', joined = false;
  const result = await Effect.runPromise(Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const layer = Layer.succeed(Processes, { run: command => command.cmd === 'git'
      ? Effect.succeed({ code: 0, stdout: remote() })
      : Effect.gen(function* () {
        home = command.env!.HOME;
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }).pipe(Effect.ensuring(Effect.sync(() => { assert.ok(existsSync(home)); joined = true; }))),
    });
    const fiber = yield* Effect.forkChild(discoverSkills(source, { tempDir: root }).pipe(Effect.provide(layer)));
    yield* Deferred.await(started);
    yield* TestClock.adjust(DISCOVERY_LIMITS.timeoutMs);
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer())));
  assert.deepEqual(result, unavailable('timeout'));
  assert.equal(joined, true);
  assert.equal(existsSync(home), false);
});

test('oversized stdout or stderr is unavailable, never partial', async t => {
  for (const output of [
    { stdout: fixture('singular') + 'x'.repeat(DISCOVERY_LIMITS.stdoutBytes), stderr: '' },
    { stdout: fixture('singular'), stderr: 'x'.repeat(DISCOVERY_LIMITS.stderrBytes + 1) },
  ]) {
    const f = fakeDiscovery(t, command => Effect.succeed({ code: 0, ...(command.cmd === 'git' ? { stdout: remote() } : output) }));
    assert.deepEqual(await Effect.runPromise(f.effect), unavailable('too-large'));
    assert.deepEqual(readdirSync(f.root), []);
  }
  const f = fakeDiscovery(t, () => Effect.fail(new LaunchFailed({ cmd: 'npx', reason: 'capture byte limit exceeded' })));
  assert.deepEqual(await Effect.runPromise(f.effect), unavailable('too-large'));
});

test('failed commands and unreadable listings never return a partial catalog', async t => {
  for (const [code, stdout, reason] of [[1, fixture('singular'), 'cli-failed'], [0, fixture('unknown-line'), 'unparseable']] as const) {
    const f = fakeDiscovery(t, command => Effect.succeed(command.cmd === 'git' ? { code: 0, stdout: remote() } : { code, stdout }));
    assert.deepEqual(await Effect.runPromise(f.effect), unavailable(reason));
    assert.deepEqual(readdirSync(f.root), []);
  }
  const f = fakeDiscovery(t, () => Effect.succeed({ code: 0, stdout: 'not a HEAD' }));
  assert.deepEqual(await Effect.runPromise(f.effect), unavailable('cli-failed'));
});

test('unconfirmed process cleanup retains HOME and exposes a cleanup defect', async t => {
  let home = '';
  const f = fakeDiscovery(t, command => {
    home = command.env!.HOME;
    command.onCleanup?.({ joined: false });
    return Effect.fail(new LaunchFailed({ cmd: command.cmd, reason: 'capture cleanup deadline exceeded' }));
  });
  const exit = await Effect.runPromise(Effect.exit(f.effect));
  assert.ok(Exit.isFailure(exit));
  assert.ok(exit.cause.reasons.some(r => Cause.isDieReason(r) && r.defect instanceof SourceCleanupFailed));
  assert.ok(existsSync(home));
});

const runContents = <A, E>(effect: Effect.Effect<A, E, Git | Fs>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(nodeFs, nodeGit({ allowProtocols: 'file' })))));

test('readSkillContents finds a nested skill by frontmatter name, not folder name', async t => {
  const root = tempDir(t), repo = makeRepo(root);
  const text = '---\nname: "actual-name"\ndescription: A skill.\n---\n# Actual skill\n';
  const revision = repo.commit('nested skill', {
    'plugins/demo/skills/different-folder/SKILL.md': text,
    'plugins/demo/skills/different-folder/references/guide.txt': 'Guide',
    'unrelated.txt': 'Not part of the skill',
  });
  const options = { cacheDir: join(root, 'cache') };
  repo.commit('later contents', { 'plugins/demo/skills/different-folder/SKILL.md': '---\nname: later\n---\n' });
  const result = await runContents(readSkillContents(repo.url, revision, 'actual-name', options));
  assert.deepEqual(result, { path: 'plugins/demo/skills/different-folder', text, files: ['SKILL.md', 'references/guide.txt'] });
  assert.ok('unavailable' in await runContents(readSkillContents(repo.url, revision, 'different-folder', options)));
});

test('content reads include root skills and refuse missing or duplicate frontmatter names', async t => {
  const root = tempDir(t), repo = makeRepo(root);
  const text = "---\nname: 'root-name'\n---\nRoot skill\n";
  const revision = repo.commit('root skill', { 'SKILL.md': text, 'reference.md': 'Reference' });
  assert.deepEqual(await runContents(readSkillContents(repo.url, revision, 'root-name', { cacheDir: join(root, 'cache') })),
    { path: '.', text, files: ['SKILL.md', 'reference.md'] });
  assert.ok('unavailable' in await runContents(readSkillContents(repo.url, revision, 'missing', { cacheDir: join(root, 'cache') })));
  const duplicate = repo.commit('ambiguous name', { 'nested/SKILL.md': text });
  assert.ok('unavailable' in await runContents(readSkillContents(repo.url, duplicate, 'root-name', { cacheDir: join(root, 'cache') })));
});

test('content text is byte capped and failed Git reads are unavailable', async t => {
  const root = tempDir(t), repo = makeRepo(root);
  const revision = repo.commit('large skill', { 'SKILL.md': '---\nname: large\n---\n' + 'é'.repeat(SKILL_TEXT_MAX_BYTES / 2) });
  assert.ok('unavailable' in await runContents(readSkillContents(repo.url, revision, 'large', { cacheDir: join(root, 'cache') })));
  const failedGit = Layer.succeed(Git, { run: () => Effect.fail(new GitFailed({ reason: 'private diagnostic' })) });
  const failed = await Effect.runPromise(readSkillContents(source, commit, 'first', { cacheDir: join(root, 'other-cache') })
    .pipe(Effect.provide(Layer.merge(nodeFs, failedGit))));
  assert.ok('unavailable' in failed);
  assert.doesNotMatch(JSON.stringify(failed), /private diagnostic/);
});

test('shallow content reads leave the source watcher cache and history usable', async t => {
  const root = tempDir(t), repo = makeRepo(root);
  const from = repo.commit('first', { 'skills/one/SKILL.md': '---\nname: one\n---\nOld\n' });
  const to = repo.commit('second', { 'skills/one/SKILL.md': '---\nname: one\n---\nNew\n' });
  const options = { cacheDir: join(root, 'cache') };
  assert.ok('text' in await runContents(readSkillContents(repo.url, from, 'one', options)));
  const report = await runContents(watchUpstreamWithServices({
    source, url: repo.url, baseline: from, skills: ['one'], exact: false,
  }, options));
  assert.equal(report.latest?.sha, to);
  assert.equal(report.status, 'ahead');
  assert.equal(report.skills[0]?.status, 'changed');
});
