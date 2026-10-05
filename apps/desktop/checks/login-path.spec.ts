import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingTools, probeLoginPath } from '../backend/login-path.ts';

const dir = mkdtempSync(join(tmpdir(), 'nortuscc-login-path-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const script = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

test('reads PATH from between markers despite login banners', async () => {
  // Runs the probe's own script ($2) with a PATH a login rc file would set.
  const shell = script('noisy', 'echo "Welcome to your shell"\nPATH=/opt/tools/bin:/usr/bin\nexport PATH\n/bin/sh -c "$2"\necho "bye"');
  assert.deepEqual(await probeLoginPath({ env: { SHELL: shell, PATH: '/inherited' } }), { path: '/opt/tools/bin:/usr/bin' });
});

test('a hanging shell times out and falls back to the inherited PATH', async () => {
  const shell = script('hang', '/bin/sleep 30');
  const started = Date.now();
  const result = await probeLoginPath({ env: { SHELL: shell, PATH: '/inherited' }, timeoutMs: 200 });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.path, '/inherited');
  assert.match(result.error!, /timed out/);
});

test('a missing shell falls back with a probe error', async () => {
  const result = await probeLoginPath({ env: { SHELL: join(dir, 'absent-shell'), PATH: '/inherited' } });
  assert.equal(result.path, '/inherited');
  assert.match(result.error!, /absent-shell/);
});

test('a shell that prints no PATH falls back', async () => {
  const shell = script('silent', 'exit 0');
  const result = await probeLoginPath({ env: { SHELL: shell, PATH: '/inherited' } });
  assert.equal(result.path, '/inherited');
  assert.match(result.error!, /no PATH/);
});

test('missingTools names each tool not executable on PATH', () => {
  const bin = mkdtempSync(join(dir, 'bin-'));
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\n');
  chmodSync(join(bin, 'npx'), 0o755);
  writeFileSync(join(bin, 'claude'), 'not executable');
  assert.deepEqual(missingTools(['npx', 'claude', 'codex'], `${bin}:/nonexistent`), [
    "'claude' was not found on the login shell's PATH",
    "'codex' was not found on the login shell's PATH",
  ]);
});
