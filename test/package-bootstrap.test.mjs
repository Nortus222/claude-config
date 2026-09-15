import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;

test('the packed GitHub package installs a working global command', { skip: !npmCli }, () => {
  const stage = mkdtempSync(join(tmpdir(), 'nortuscc-package-'));
  const prefix = join(stage, 'prefix');
  const packed = JSON.parse(execFileSync(
    process.execPath,
    [npmCli, 'pack', '--json', '--pack-destination', stage],
    { cwd: REPO, encoding: 'utf8' },
  ))[0];

  assert.ok(packed.files.some((entry) => entry.path === 'integrations.json'));
  assert.ok(packed.files.some((entry) => entry.path === 'src/commands/setup.mjs'));
  assert.equal(packed.files.some((entry) => entry.path.startsWith('test/')), false);

  execFileSync(
    process.execPath,
    [npmCli, 'install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', join(stage, packed.filename)],
    { stdio: 'ignore' },
  );

  const command = process.platform === 'win32'
    ? join(prefix, 'nortuscc.cmd')
    : join(prefix, 'bin', 'nortuscc');
  assert.ok(existsSync(command));

  const output = process.platform === 'win32'
    ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command, '--help'], { encoding: 'utf8' })
    : execFileSync(command, ['--help'], { encoding: 'utf8' });
  assert.match(output, /Usage: nortuscc/);
});
