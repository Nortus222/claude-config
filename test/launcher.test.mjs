import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_STDIO, installGlobalCommand, isCheckout, missingRuntime, npmCommand, recordedCheckout, setupFromCopy } from '../bin/launcher.mjs';
import { VERBS } from '../bin/commands.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'nortuscc-launcher-'));
const nortuscc = (dir) => {
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'nortuscc.mjs'), '');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'nortuscc', bin: { nortuscc: './bin/nortuscc.mjs' } }));
  return dir;
};

test('a git checkout outside node_modules is a checkout', () => {
  const dir = nortuscc(join(scratch(), 'claude-config'));
  assert.equal(isCheckout(dir), true);
});

test('an npx copy under node_modules is not a checkout even with .git', () => {
  const dir = nortuscc(join(scratch(), 'node_modules', 'nortuscc'));
  assert.equal(isCheckout(dir), false);
});

test('missingRuntime is true until effect is installed', () => {
  const dir = scratch();
  assert.equal(missingRuntime(dir), true);
  mkdirSync(join(dir, 'node_modules', 'effect'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'effect', 'package.json'), '{}');
  assert.equal(missingRuntime(dir), false);
});

test('recordedCheckout accepts only an existing nortuscc checkout', () => {
  const home = scratch();
  const state = join(home, '.config', 'nortuscc');
  mkdirSync(state, { recursive: true });
  const write = (repo) => writeFileSync(join(state, 'state.json'), JSON.stringify({ repo, files: {} }));
  write(join(home, 'gone'));
  assert.equal(recordedCheckout({}, home, 'darwin'), null);
  const repo = nortuscc(join(home, 'claude-config'));
  write(repo);
  assert.equal(recordedCheckout({}, home, 'darwin'), repo);
  assert.equal(recordedCheckout({ NORTUSCC_STATE_DIR: join(home, 'elsewhere') }, home, 'darwin'), null);
});

test('recordedCheckout rejects a checkout recorded under node_modules', () => {
  const home = scratch();
  const state = join(home, '.config', 'nortuscc');
  mkdirSync(state, { recursive: true });
  const repo = nortuscc(join(home, 'node_modules', 'nortuscc'));
  writeFileSync(join(state, 'state.json'), JSON.stringify({ repo, files: {} }));
  assert.equal(recordedCheckout({}, home, 'darwin'), null);
});

// '' rather than undefined: undefined would pick up npm_execpath, which `npm test` sets.
test('npmCommand prefers npm_execpath, then the bundled npm-cli.js, then plain npm', () => {
  const args = ['ci'];
  const node = join('x', 'bin', 'node');
  assert.deepEqual(
    npmCommand({ args, node, npmExecPath: '/p/npm-cli.js', platform: 'win32', exists: () => false }),
    { cmd: node, args: ['/p/npm-cli.js', 'ci'] },
  );
  const bundled = join('x', 'bin', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assert.deepEqual(
    npmCommand({ args, node, npmExecPath: '', platform: 'win32', exists: (p) => p === bundled }),
    { cmd: node, args: [bundled, 'ci'] },
  );
  assert.deepEqual(
    npmCommand({ args, node, npmExecPath: '', platform: 'darwin', exists: () => false }),
    { cmd: 'npm', args: ['ci'] },
  );
  assert.throws(() => npmCommand({ args, node, npmExecPath: '', platform: 'win32', exists: () => false }));
});

// A checkout without its runtime cannot run any command, so a failed install exits 1 whatever the verb.
test('a checkout whose runtime install fails exits 1 for every verb', () => {
  const dir = join(scratch(), 'claude-config');
  mkdirSync(join(dir, '.git'), { recursive: true });
  cpSync(fileURLToPath(new URL('../bin', import.meta.url)), join(dir, 'bin'), { recursive: true });
  const failingNpm = join(dir, 'npm-cli.js');
  writeFileSync(failingNpm, 'process.exit(3);\n');
  for (const verb of VERBS) {
    const result = spawnSync(process.execPath, [join(dir, 'bin', 'nortuscc.mjs'), verb], {
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: failingNpm, NORTUSCC_STATE_DIR: join(dir, 'state') },
    });
    assert.equal(result.status, 1, verb);
    assert.match(result.stderr, /could not install dependencies \(npm exited with 3\)/, verb);
  }
});

test('npm output goes to stderr so it never mixes with a command report', () => {
  assert.deepEqual(INSTALL_STDIO, ['ignore', 2, 2]);
});

test('the Windows bootstrap runs npm through Node instead of a blocked PowerShell script', () => {
  const calls = [];
  const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  const root = 'C:\\Users\\Ravi Cheema\\claude-config';

  installGlobalCommand(root, {
    platform: 'win32',
    node: 'C:\\Program Files\\nodejs\\node.exe',
    npmExecPath: npmCli,
    run: (cmd, args) => calls.push({ cmd, args }),
  });

  assert.deepEqual(calls, [{
    cmd: 'C:\\Program Files\\nodejs\\node.exe',
    args: [npmCli, 'install', '--global', '--no-audit', '--no-fund', root],
  }]);
});

test('setup from an npx copy refuses before cloning when there is no terminal and no --yes', () => {
  const home = scratch();
  const error = console.error;
  let said = '';
  console.error = (message) => { said += message; };
  try {
    assert.equal(setupFromCopy([], { env: {}, home, platform: 'darwin', isTTY: false }), 2);
  } finally {
    console.error = error;
  }
  assert.match(said, /--yes/);
  assert.equal(existsSync(join(home, 'claude-config')), false);
});
