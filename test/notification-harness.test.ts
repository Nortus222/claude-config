import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cliEnv, machine } from './support/cli.ts';

test('CLI fixtures reject notification delivery through an inert executable first on PATH', (t) => {
  const m = machine({ repo: 'checkout' });
  t.after(() => {
    rmSync(m.home, { recursive: true, force: true });
    rmSync(m.bin, { recursive: true, force: true });
  });
  const executable = join(m.bin, 'notify-send');
  assert.equal(existsSync(executable), true, 'fixture must intercept notify-send before the inherited PATH');
  const result = spawnSync(process.execPath, [executable, 'Review & apply', 'Items need review'], { env: cliEnv(m), encoding: 'utf8' });
  assert.equal(result.status, 1, 'unavailable delivery remains retryable');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(existsSync(m.log), false, 'notification refusal is separate from installer mutation logs');
  assert.equal(cliEnv(m).PATH?.split(process.platform === 'win32' ? ';' : ':')[0], m.bin);
});
