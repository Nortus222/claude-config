import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPrerequisites, PREREQUISITES, prerequisiteCommand, executableAvailable, refreshPrerequisitePath } from '../src/prerequisites.mjs';

function harness({ present = [], answers = [], platform = 'darwin', installWorks = true, refresh = true } = {}) {
  const available = new Set(present);
  const questions = [];
  const commands = [];
  const messages = [];
  return {
    available, questions, commands, messages,
    options: {
      isTTY: true, platform, refreshPath: async () => {},
      check: async (command) => available.has(command),
      confirm: async (question) => { questions.push(question); return answers.shift() ?? false; },
      output: { write: (message) => messages.push(message) },
      run: async (command) => {
        commands.push(command);
        if (command.cmd === 'brew' || command.cmd === 'winget') {
          if (!installWorks) return { ok: false, note: 'installer failed' };
          if (refresh) for (const tool of PREREQUISITES) {
            if (command.args.includes(tool.brew) || command.args.includes(tool.winget)) {
              for (const executable of tool.executables) available.add(executable);
            }
          }
        }
        return { ok: true };
      },
    },
  };
}

const all = PREREQUISITES.flatMap((tool) => tool.executables);

test('noninteractive prerequisites do not probe, prompt, or install', async () => {
  const unexpected = () => { throw new Error('should not run'); };
  assert.equal(await setupPrerequisites({ isTTY: false, check: unexpected, confirm: unexpected, run: unexpected }), 0);
});

test('present tools are not offered installation and setup is opt-in per tool', async () => {
  const h = harness({ present: all, answers: [true, true, false] });
  assert.equal(await setupPrerequisites(h.options), 0);
  assert.equal(h.questions.length, 3);
  assert.ok(h.questions.every((question) => !question.startsWith('Install')));
  assert.deepEqual(h.commands, [{ cmd: 'gh', args: ['auth', 'login'] }, { cmd: 'claude', args: ['auth', 'login'] }]);
});

test('declining all missing tools succeeds without running commands', async () => {
  const h = harness();
  assert.equal(await setupPrerequisites(h.options), 0);
  assert.equal(h.questions.length, PREREQUISITES.length);
  assert.deepEqual(h.commands, []);
});

test('macOS installs each missing tool individually and rechecks it before setup', async () => {
  const h = harness({ present: ['brew', ...all.filter((name) => name !== 'gh')], answers: [true, true] });
  assert.equal(await setupPrerequisites(h.options), 0);
  assert.deepEqual(h.commands, [
    { cmd: 'brew', args: ['install', 'gh'] },
    { cmd: 'gh', args: ['auth', 'login'] },
  ]);
});

test('Windows uses exact official WinGet package IDs without shell interpolation', async () => {
  const h = harness({ platform: 'win32', present: ['winget'], answers: [true, true, true, false, true, false, true, false] });
  assert.equal(await setupPrerequisites(h.options), 0);
  assert.equal(h.commands.length, PREREQUISITES.length);
  for (let i = 0; i < PREREQUISITES.length; i++) {
    assert.deepEqual(h.commands[i], {
      cmd: 'winget', args: ['install', '--id', PREREQUISITES[i].winget, '--exact', '--source', 'winget'],
    });
  }
});

test('Node prerequisite requires npm and npx as well as node', async () => {
  const h = harness({ present: ['brew', ...all.filter((name) => name !== 'npm')], answers: [true] });
  assert.equal(await setupPrerequisites(h.options), 0);
  assert.deepEqual(h.commands, [{ cmd: 'brew', args: ['install', 'node'] }]);
});

test('missing package manager gives guidance and does not attempt installation', async () => {
  const h = harness({ present: all.filter((name) => name !== 'git'), answers: [true] });
  assert.equal(await setupPrerequisites(h.options), 1);
  assert.deepEqual(h.commands, []);
  assert.match(h.messages.join(''), /Homebrew.*https:\/\/brew.sh/);
});

test('selected installation failures are reported and later tools still run', async () => {
  const h = harness({ present: ['brew', ...all.filter((name) => !['git', 'node', 'npm', 'npx'].includes(name))], answers: [true, true], installWorks: false });
  assert.equal(await setupPrerequisites(h.options), 1);
  assert.equal(h.commands.length, 2);
  assert.match(h.messages.join(''), /installer failed/);
});

test('an installed tool absent from PATH reports restart guidance and skips setup', async () => {
  const h = harness({ present: ['winget', ...all.filter((name) => name !== 'gh')], platform: 'win32', answers: [true, true], refresh: false });
  assert.equal(await setupPrerequisites(h.options), 1);
  assert.equal(h.commands.length, 2); // gh install, then setup for present Claude Code
  assert.equal(h.commands[1].cmd, 'claude');
  assert.match(h.messages.join(''), /Restart.*terminal.*PATH/);
  assert.ok(!h.questions.some((question) => question.startsWith('Set up GitHub')));
});

test('selected setup failures and runner exceptions report errors without stopping other tools', async () => {
  const h = harness({ present: all, answers: [true, true] });
  h.options.run = async ({ cmd }) => { if (cmd === 'gh') throw new Error('login failed'); return { ok: false, note: 'setup failed' }; };
  assert.equal(await setupPrerequisites(h.options), 1);
  assert.match(h.messages.join(''), /login failed/);
  assert.match(h.messages.join(''), /setup failed/);
});

test('Windows account setup uses fixed PowerShell scripts for .cmd shims', () => {
  assert.deepEqual(prerequisiteCommand({ cmd: 'claude', args: ['auth', 'login'] }, 'win32'), {
    cmd: 'powershell.exe', args: ['-NoProfile', '-Command', "$tool = Get-Command claude -CommandType Application -ErrorAction Stop; & $tool.Source auth login; exit $LASTEXITCODE"],
  });
  const install = { cmd: 'winget', args: ['install', '--id', 'Anthropic.ClaudeCode'] };
  assert.equal(prerequisiteCommand(install, 'win32'), install);
  const other = { cmd: 'claude', args: ['auth', 'login; Write-Output injected'] };
  assert.equal(prerequisiteCommand(other, 'win32'), other);
  assert.deepEqual(prerequisiteCommand({ cmd: 'codex', args: ['login'] }, 'darwin'), { cmd: 'codex', args: ['login'] });
});

test('PATH detection recognizes Windows command shims and rejects directories', async () => {
  const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'prerequisites-'));
  try {
    await writeFile(path.join(root, 'npm.CMD'), '@echo off');
    await mkdir(path.join(root, 'npx.CMD'));
    const options = { platform: 'win32', env: { PATH: `"${root}"`, PATHEXT: '.EXE;.CMD' } };
    assert.equal(await executableAvailable('npm', options), true);
    assert.equal(await executableAvailable('npx', options), false);
    assert.equal(await executableAvailable('missing', options), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unsupported platforms provide manual guidance only after installation is accepted', async () => {
  const h = harness({ platform: 'linux', answers: [true] });
  assert.equal(await setupPrerequisites({ ...h.options, tools: [PREREQUISITES[0]] }), 1);
  assert.deepEqual(h.commands, []);
  assert.match(h.messages.join(''), /Install Git manually.*https:\/\/git-scm.com/);
});


test('Windows refreshes installer PATH before rechecking and offering login', async () => {
  const h = harness({ platform: 'win32', present: ['winget'], answers: [true, true], refresh: false });
  let refreshes = 0;
  h.options.refreshPath = async () => { refreshes++; h.available.add('gh'); };
  assert.equal(await setupPrerequisites({ ...h.options, tools: [PREREQUISITES.find((tool) => tool.id === 'gh')] }), 0);
  assert.equal(refreshes, 1);
  assert.deepEqual(h.commands[1], { cmd: 'gh', args: ['auth', 'login'] });
});

test('Windows PATH refresh preserves session paths and adds machine and user paths', async () => {
  const env = { Path: 'C:\\session;C:\\existing' };
  const commands = [];
  assert.equal(await refreshPrerequisitePath({ platform: 'win32', env, capture: async (command) => {
    commands.push(command);
    return { ok: true, stdout: 'C:\\machine;C:\\existing;C:\\user\r\n' };
  } }), true);
  assert.equal(env.Path, 'C:\\session;C:\\existing;C:\\machine;C:\\user');
  assert.equal(commands[0].cmd, 'powershell.exe');
  assert.match(commands[0].args[2], /GetEnvironmentVariable\('Path', 'Machine'\)/);
  assert.match(commands[0].args[2], /GetEnvironmentVariable\('Path', 'User'\)/);
});

test('PATH refresh does nothing on macOS and preserves PATH when registry reading fails', async () => {
  const unexpected = () => { throw new Error('should not run'); };
  assert.equal(await refreshPrerequisitePath({ platform: 'darwin', capture: unexpected }), true);
  const env = { PATH: 'original' };
  assert.equal(await refreshPrerequisitePath({ platform: 'win32', env, capture: async () => ({ ok: false }) }), false);
  assert.equal(env.PATH, 'original');
});
