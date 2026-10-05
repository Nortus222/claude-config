import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCheckout, missingRuntime, npmCommand, recordedCheckout } from '../bin/launcher.mjs';
import { PORTED, VERBS } from '../bin/commands.mjs';

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

test('PORTED is a subset of VERBS', () => {
  assert.ok(PORTED.every((verb) => VERBS.includes(verb)));
});

test('recordedCheckout rejects a checkout recorded under node_modules', () => {
  const home = scratch();
  const state = join(home, '.config', 'nortuscc');
  mkdirSync(state, { recursive: true });
  const repo = nortuscc(join(home, 'node_modules', 'nortuscc'));
  writeFileSync(join(state, 'state.json'), JSON.stringify({ repo, files: {} }));
  assert.equal(recordedCheckout({}, home, 'darwin'), null);
});

test('npmCommand prefers npm_execpath, then the bundled npm-cli.js, then plain npm', () => {
  const args = ['ci'];
  const node = join('x', 'bin', 'node');
  assert.deepEqual(
    npmCommand({ args, node, npmExecPath: '/p/npm-cli.js', platform: 'win32', exists: () => false }),
    { cmd: node, args: ['/p/npm-cli.js', 'ci'] },
  );
  const bundled = join('x', 'bin', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assert.deepEqual(
    npmCommand({ args, node, npmExecPath: undefined, platform: 'win32', exists: (p) => p === bundled }),
    { cmd: node, args: [bundled, 'ci'] },
  );
  assert.deepEqual(
    npmCommand({ args, node, npmExecPath: undefined, platform: 'darwin', exists: () => false }),
    { cmd: 'npm', args: ['ci'] },
  );
  assert.throws(() => npmCommand({ args, node, npmExecPath: undefined, platform: 'win32', exists: () => false }));
});
