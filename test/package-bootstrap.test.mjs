import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;

let stage;
let command;

// Packs the repo and installs it globally once for every test below.
before(() => {
  if (!npmCli) return;
  stage = mkdtempSync(join(tmpdir(), 'nortuscc-package-'));
  const prefix = join(stage, 'prefix');
  const packed = JSON.parse(execFileSync(
    process.execPath,
    [npmCli, 'pack', '--json', '--pack-destination', stage],
    { cwd: REPO, encoding: 'utf8' },
  ))[0];

  // An npx copy runs only bin/: setup clones a checkout, every other verb hands off to one.
  for (const path of ['bin/nortuscc.mjs', 'bin/launcher.mjs', 'bin/commands.mjs', 'integrations.json']) {
    assert.ok(packed.files.some((entry) => entry.path === path), path);
  }
  assert.equal(packed.files.some((entry) => entry.path.startsWith('src/') || entry.path.startsWith('packages/')), false);
  assert.equal(packed.files.some((entry) => entry.path.startsWith('test/')), false);

  execFileSync(
    process.execPath,
    [npmCli, 'install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', join(stage, packed.filename)],
    { stdio: 'ignore' },
  );

  command = process.platform === 'win32'
    ? join(prefix, 'nortuscc.cmd')
    : join(prefix, 'bin', 'nortuscc');
});

test('the packed GitHub package installs a working global command', { skip: !npmCli }, () => {
  assert.ok(existsSync(command));

  const output = process.platform === 'win32'
    ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command, '--help'], { encoding: 'utf8' })
    : execFileSync(command, ['--help'], { encoding: 'utf8' });
  assert.match(output, /Usage: nortuscc/);
});

test('a packed copy with no recorded checkout runs nothing and says how to get one', { skip: !npmCli }, () => {
  const state = join(stage, 'no-record');
  mkdirSync(state, { recursive: true });
  const result = spawnSync(command, ['uninstall', '--target', 'all'], {
    encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, NORTUSCC_STATE_DIR: state },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /'uninstall' needs a nortuscc checkout/);
});

test('an npx copy hands a verb to the recorded checkout', { skip: !npmCli }, () => {
  const copy = join(stage, 'node_modules', 'nortuscc');
  mkdirSync(copy, { recursive: true });
  cpSync(join(REPO, 'bin'), join(copy, 'bin'), { recursive: true });

  const state = join(stage, 'state');
  mkdirSync(state, { recursive: true });
  const record = (repo) => writeFileSync(join(state, 'state.json'), JSON.stringify({ repo, files: {} }));
  const launch = () => spawnSync(
    process.execPath,
    [join(copy, 'bin', 'nortuscc.mjs'), 'status', '--strict', '--target', 'bogus'],
    { encoding: 'utf8', env: { ...process.env, NORTUSCC_STATE_DIR: state } },
  );

  record(REPO);
  const handed = launch();
  assert.equal(handed.status, 2);
  assert.match(handed.stderr, /--target must be claude\|codex\|all/);

  record(join(stage, 'missing'));
  const refused = launch();
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /needs a nortuscc checkout/);
});
