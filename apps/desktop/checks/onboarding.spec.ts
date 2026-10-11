import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Effect, Layer } from 'effect';
import { Processes, type Command } from '@nortuscc/machine';
import { bootstrapSetup, decodeSetupChoices, requestGitInstall, setupState, type OnboardingInput } from '../agent/onboarding.ts';

const fixture = (t: { after: (f: () => void) => void }) => {
  const root = mkdtempSync(join(tmpdir(), 'ncc-onboard-'));
  const home = join(root, 'home'); mkdirSync(home);
  const developer = join(root, 'developer'); mkdirSync(join(developer, 'usr/bin'), { recursive: true });
  writeFileSync(join(developer, 'usr/bin/git'), 'inert Git fixture');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateRoot = join(home, 'state');
  const commands: Command[] = [];
  const processes = Layer.succeed(Processes, { run: (command) => Effect.sync(() => {
    commands.push(command);
    return { code: 0, stdout: developer + '\n', stderr: '' };
  }) });
  const input: OnboardingInput = { home, env: { HOME: home, NORTUSCC_STATE_DIR: stateRoot }, platform: 'darwin', processes };
  return { home, stateRoot, commands, input, developer };
};

test('a new Mac can inspect setup prerequisites without writing state or starting an installer', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await setupState(f.input), { needsSetup: true, repo: null, gitAvailable: true, canInstallGit: true,
    defaultRepoUrl: 'https://github.com/Nortus222/claude-config.git' });
  assert.deepEqual(f.commands.map((c) => [c.cmd, c.args]), [['/usr/bin/xcode-select', ['-p']]]);
  assert.deepEqual(readdirSync(f.home), []);
});

test('existing recorded checkout is used without replacing choices, while corrupt or missing records fail', async (t) => {
  const f = fixture(t); const repo = join(f.home, 'existing');
  mkdirSync(join(repo, '.git'), { recursive: true }); mkdirSync(f.stateRoot);
  const before = JSON.stringify({ version: 1, repo, files: { 'claude:CLAUDE.md': { hash: 'old', appliedAt: 'old' } } });
  writeFileSync(join(f.stateRoot, 'state.json'), before);
  assert.equal((await setupState(f.input)).repo, repo);
  assert.equal(readFileSync(join(f.stateRoot, 'state.json'), 'utf8'), before);
  rmSync(repo, { recursive: true });
  await assert.rejects(setupState(f.input), /checkout/);
  writeFileSync(join(f.stateRoot, 'state.json'), '{bad');
  await assert.rejects(setupState(f.input), /state.json/);
});

test('Git installation requires an explicit fixed request and setup choices reject extra authority', async (t) => {
  const f = fixture(t);
  for (const value of [{ configTargets: ['claude', 'claude'] }, { configTargets: ['all'] }, { configTargets: [], repo: '/tmp' }, { configTargets: [], command: 'sh' }]) assert.throws(() => decodeSetupChoices(value));
  assert.deepEqual(decodeSetupChoices({ configTargets: [] }), { configTargets: [] });
  await requestGitInstall(f.input);
  assert.deepEqual(f.commands.map((c) => [c.cmd, c.args]), [['/usr/bin/xcode-select', ['--install']]]);
  await assert.rejects(requestGitInstall({ ...f.input, platform: 'linux' }), /macOS/);
});

test('bootstrap clones fixed origin, records choices with backups, and retry preserves metadata', async (t) => {
  const f = fixture(t);
  mkdirSync(f.stateRoot);
  writeFileSync(join(f.stateRoot, 'state.json'), JSON.stringify({ version: 1, repo: null, files: { existing: { hash: 'x', appliedAt: 'before' } } }));
  writeFileSync(join(f.stateRoot, 'overrides.json'), JSON.stringify({ version: 1, manageConfig: true, configTargets: ['codex'], skills: { demo: false } }));
  mkdirSync(join(f.stateRoot, 'agent'));
  const policy = JSON.stringify({ version: 1, policy: 'manual', policySource: 'person', paused: { reason: 'keep', at: 'old' }, installedBy: 'cli' });
  writeFileSync(join(f.stateRoot, 'agent/agent.json'), policy);
  const input = { ...f.input, processes: Layer.succeed(Processes, { run: (command: Command) => Effect.sync(() => {
    f.commands.push(command);
    if (command.args.includes('clone')) {
      const checkout = command.args.at(-1)!;
      mkdirSync(join(checkout, '.git'), { recursive: true });
      writeFileSync(join(checkout, 'integrations.json'), '{"version":1,"integrations":[]}');
      writeFileSync(join(checkout, 'skills-manifest.txt'), '');
      return { code: 0, stdout: '' };
    }
    return { code: 0, stdout: command.args.includes('get-url') ? 'https://github.com/Nortus222/claude-config.git\n' : f.developer + '\n' };
  }) }) };
  assert.deepEqual(await bootstrapSetup(input, { configTargets: ['claude'] }), { stateRoot: f.stateRoot });
  const state = JSON.parse(readFileSync(join(f.stateRoot, 'state.json'), 'utf8'));
  assert.deepEqual(state.files, { existing: { hash: 'x', appliedAt: 'before' } });
  assert.ok(state.repo.startsWith(f.stateRoot + '/desktop-setup-'));
  const overrides = JSON.parse(readFileSync(join(f.stateRoot, 'overrides.json'), 'utf8'));
  assert.deepEqual(overrides.configTargets, ['codex'], 'existing choices are preserved');
  assert.equal(readFileSync(join(f.stateRoot, 'agent/agent.json'), 'utf8'), policy);
  const clone = f.commands.find((c) => c.args.includes('clone'))!;
  assert.ok(clone.args.includes('core.hooksPath=/dev/null'));
  assert.equal(clone.env?.GIT_TERMINAL_PROMPT, '0');
  assert.ok(readdirSync(join(f.stateRoot, 'backups')).length > 0);
  const before = readFileSync(join(f.stateRoot, 'state.json'), 'utf8');
  await bootstrapSetup(input, { configTargets: [] });
  assert.equal(readFileSync(join(f.stateRoot, 'state.json'), 'utf8'), before);
  assert.equal(f.commands.filter((c) => c.args.includes('clone')).length, 1);
});

test('missing Git never opens the installer or clones on a read-only check or bootstrap', async (t) => {
  const f = fixture(t);
  const input = { ...f.input, processes: Layer.succeed(Processes, { run: (command: Command) => Effect.sync(() => {
    f.commands.push(command); return { code: 1, stdout: '', stderr: 'absent' };
  }) }) };
  assert.equal((await setupState(input)).gitAvailable, false);
  await assert.rejects(bootstrapSetup(input, { configTargets: [] }), /Git is required/);
  assert.ok(f.commands.every((command) => command.cmd === '/usr/bin/xcode-select' && command.args.join('') === '-p'));
});

test('failed clone and invalid fixed origin remove only the owned temporary checkout and remain retryable', async (t) => {
  const f = fixture(t);
  mkdirSync(f.stateRoot); const unrelated = join(f.stateRoot, 'desktop-setup-existing');
  mkdirSync(unrelated); writeFileSync(join(unrelated, 'keep'), 'user data');
  for (const mode of ['clone', 'origin', 'profile']) {
    const input = { ...f.input, processes: Layer.succeed(Processes, { run: (command: Command) => Effect.sync(() => {
      if (command.args.includes('clone')) {
        const checkout = command.args.at(-1)!; mkdirSync(join(checkout, '.git'), { recursive: true });
        writeFileSync(join(checkout, 'integrations.json'), mode === 'profile' ? '{bad' : '{"version":1,"integrations":[]}');
        writeFileSync(join(checkout, 'skills-manifest.txt'), '');
        return { code: mode === 'clone' ? 1 : 0, stdout: '' };
      }
      return { code: 0, stdout: command.cmd === '/usr/bin/xcode-select' ? f.developer : command.args.includes('get-url')
        ? (mode === 'origin' ? 'https://evil.invalid/repo' : 'https://github.com/Nortus222/claude-config.git') : 'ok' };
    }) }) };
    await assert.rejects(bootstrapSetup(input, { configTargets: ['claude'] }));
    assert.deepEqual(readdirSync(f.stateRoot), ['desktop-setup-existing']);
    assert.equal(readFileSync(join(unrelated, 'keep'), 'utf8'), 'user data');
  }
});

test('clone timeout joins its child before cleaning its directory', async (t) => {
  const f = fixture(t); let joined = false; let childRoot = '';
  const input = { ...f.input, timeoutMs: 10, processes: Layer.succeed(Processes, { run: (command: Command) => {
    if (!command.args.includes('clone')) return Effect.succeed({ code: 0, stdout: f.developer });
    childRoot = command.args.at(-1)!;
    mkdirSync(childRoot, { recursive: true });
    return Effect.callback(() => Effect.promise(async () => {
      assert.ok(readdirSync(childRoot));
      await new Promise((done) => setTimeout(done, 10));
      writeFileSync(join(childRoot, 'last-child-write'), 'joined');
      joined = true;
    }));
  } }) };
  await assert.rejects(bootstrapSetup(input, { configTargets: [] }));
  assert.equal(joined, true);
  assert.deepEqual(readdirSync(f.stateRoot), []);
});

test('fresh bootstrap records notify and selected targets without changing configuration files', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, '.claude')); writeFileSync(join(f.home, '.claude/CLAUDE.md'), 'owner config');
  const input = { ...f.input, processes: Layer.succeed(Processes, { run: (command: Command) => Effect.sync(() => {
    if (command.args.includes('clone')) {
      const checkout = command.args.at(-1)!; mkdirSync(join(checkout, '.git'), { recursive: true });
      writeFileSync(join(checkout, 'integrations.json'), '{"version":1,"integrations":[]}');
      writeFileSync(join(checkout, 'skills-manifest.txt'), '');
    }
    return { code: 0, stdout: command.args.includes('get-url') ? 'https://github.com/Nortus222/claude-config.git' : f.developer };
  }) }) };
  await bootstrapSetup(input, { configTargets: ['claude', 'codex'] });
  assert.deepEqual(JSON.parse(readFileSync(join(f.stateRoot, 'overrides.json'), 'utf8')),
    { version: 1, manageConfig: true, configTargets: ['claude', 'codex'] });
  assert.deepEqual(JSON.parse(readFileSync(join(f.stateRoot, 'agent/agent.json'), 'utf8')),
    { version: 1, policy: 'notify', policySource: 'default', paused: null });
  assert.equal(readFileSync(join(f.home, '.claude/CLAUDE.md'), 'utf8'), 'owner config');
});

test('bootstrap isolates anonymous Git from ambient repository selectors, filters, rewrites and credentials', {
  skip: process.platform === 'win32' ? 'POSIX executable fixture' : false,
}, async (t) => {
  const f = fixture(t); const bin = join(f.home, 'tools'); mkdirSync(bin);
  const observed = join(f.home, 'git-env.jsonl'); const fakeGit = join(bin, 'git');
  writeFileSync(fakeGit, `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(${JSON.stringify(observed)}, JSON.stringify({env:process.env,args:process.argv.slice(2)})+'\\n');
if (process.argv.includes('clone')) {
 const repo=process.argv.at(-1); fs.mkdirSync(path.join(repo,'.git'),{recursive:true});
 fs.writeFileSync(path.join(repo,'integrations.json'),'${'{"version":1,"integrations":[]}'}');
 fs.writeFileSync(path.join(repo,'skills-manifest.txt'),'');
}
console.log(process.argv.includes('get-url') ? 'https://github.com/Nortus222/claude-config.git' : 'ok');\n`);
  chmodSync(fakeGit, 0o755);
  await bootstrapSetup({ ...f.input, platform: 'linux', processes: undefined, env: { ...f.input.env, PATH: bin,
    GIT_DIR: '/user/repository', GIT_WORK_TREE: '/user/home', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.bad.insteadOf',
    GIT_CONFIG_VALUE_0: 'https://github.com/', GIT_CONFIG_GLOBAL: '/user/gitconfig', GIT_CONFIG_SYSTEM: '/user/system' } }, { configTargets: [] });
  const operations = readFileSync(observed, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((op) => !op.args.includes('--version'));
  assert.ok(operations.length >= 3);
  for (const operation of operations) {
    assert.equal(operation.env.GIT_DIR, undefined); assert.equal(operation.env.GIT_WORK_TREE, undefined);
    assert.equal(operation.env.GIT_CONFIG_COUNT, undefined); assert.equal(operation.env.GIT_CONFIG_SYSTEM, undefined);
    assert.equal(operation.env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(operation.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.ok(operation.args.includes('credential.helper=')); assert.ok(operation.args.includes('core.hooksPath=/dev/null'));
  }
});

test('Mac prerequisite checking rejects stale developer selection but accepts standalone Git without an installer', async (t) => {
  const f = fixture(t);
  rmSync(f.developer, { recursive: true });
  assert.equal((await setupState(f.input)).gitAvailable, false);
  assert.ok(f.commands.every((command) => command.cmd === '/usr/bin/xcode-select'));
  const bin = join(f.home, 'git-bin'); mkdirSync(bin); writeFileSync(join(bin, 'git'), 'standalone fixture');
  f.commands.length = 0;
  assert.equal((await setupState({ ...f.input, env: { ...f.input.env, PATH: bin } })).gitAvailable, true);
  assert.deepEqual(f.commands.map((c) => [c.cmd, c.args]), [[realpathSync(join(bin, 'git')), ['--version']]]);
});

test('legacy machine target choices survive first desktop registration', async (t) => {
  const f = fixture(t); mkdirSync(f.stateRoot);
  writeFileSync(join(f.stateRoot, 'state.json'), JSON.stringify({ version: 1, repo: null, files: {}, skillsOnly: true, configTargets: ['codex'] }));
  const input = { ...f.input, processes: Layer.succeed(Processes, { run: (command: Command) => Effect.sync(() => {
    if (command.args.includes('clone')) {
      const checkout = command.args.at(-1)!; mkdirSync(join(checkout, '.git'), { recursive: true });
      writeFileSync(join(checkout, 'integrations.json'), '{"version":1,"integrations":[]}');
      writeFileSync(join(checkout, 'skills-manifest.txt'), '');
    }
    return { code: 0, stdout: command.args.includes('get-url') ? 'https://github.com/Nortus222/claude-config.git' : f.developer };
  }) }) };
  await bootstrapSetup(input, { configTargets: ['claude'] });
  assert.deepEqual(JSON.parse(readFileSync(join(f.stateRoot, 'overrides.json'), 'utf8')),
    { version: 1, manageConfig: false, configTargets: ['codex'] });
});
