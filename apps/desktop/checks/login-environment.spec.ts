import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingTools, probeLoginEnvironment } from '../backend/login-environment.ts';

const dir = mkdtempSync(join(tmpdir(), 'nortuscc-login-env-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const script = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

test('reads the login environment despite login banners', async () => {
  // Runs the probe's own script ($2) after an rc file that sets PATH and a secret an MCP server needs.
  const shell = script('noisy', 'echo "Welcome to your shell"\nPATH=/opt/tools/bin:/usr/bin\nAPI_TOKEN=secret\nMULTI="a\nb"\nexport PATH API_TOKEN MULTI\n/bin/sh -c "$2"\necho "bye"');
  const result = await probeLoginEnvironment({ env: { SHELL: shell, PATH: '/inherited' } });
  assert.equal(result.error, undefined);
  assert.equal(result.env.PATH, '/opt/tools/bin:/usr/bin');
  assert.equal(result.env.API_TOKEN, 'secret');
  assert.equal(result.env.MULTI, 'a\nb');
});

test('a runtime path with a space and a quote is quoted for the shell', async () => {
  const odd = join(dir, "a b's");
  mkdirSync(odd);
  const runtime = join(odd, 'node');
  symlinkSync(process.execPath, runtime);
  const shell = script('quoted', 'QUOTED_OK=yes\nexport QUOTED_OK\n/bin/sh -c "$2"');
  const result = await probeLoginEnvironment({ env: { SHELL: shell, PATH: '/inherited' }, runtime });
  assert.equal(result.error, undefined);
  assert.equal(result.env.QUOTED_OK, 'yes');
});

test('a hanging shell times out and falls back to the inherited PATH', async () => {
  const shell = script('hang', '/bin/sleep 30');
  const started = Date.now();
  const result = await probeLoginEnvironment({ env: { SHELL: shell, PATH: '/inherited' }, timeoutMs: 200 });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.env.PATH, '/inherited');
  assert.match(result.error!, /timed out/);
});

test('a background process holding stdout does not delay the PATH or outlive the probe', async () => {
  // An rc file that starts a background job leaves stdout open after the probe script prints.
  const pidFile = join(dir, 'background.pid');
  const shell = script('background', `/bin/sleep 30 &\necho $! > ${pidFile}\nPATH=/opt/tools/bin:/usr/bin\nexport PATH\n/bin/sh -c "$2"`);
  const started = Date.now();
  const result = await probeLoginEnvironment({ env: { SHELL: shell, PATH: '/inherited' }, timeoutMs: 5000 });
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  assert.equal(result.env.PATH, '/opt/tools/bin:/usr/bin');
  assert.equal(result.error, undefined);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 1000;
  while (alive() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  const lingering = alive();
  if (lingering) process.kill(pid, 'SIGKILL');
  assert.equal(lingering, false, 'the background sleep outlived the probe');
});

test('a missing shell falls back with a probe error', async () => {
  const result = await probeLoginEnvironment({ env: { SHELL: join(dir, 'absent-shell'), PATH: '/inherited' } });
  assert.equal(result.env.PATH, '/inherited');
  assert.match(result.error!, /absent-shell/);
});

test('a shell that prints no environment falls back to the inherited one', async () => {
  const shell = script('silent', 'exit 0');
  const result = await probeLoginEnvironment({ env: { SHELL: shell, PATH: '/inherited', KEEP: 'me' } });
  assert.deepEqual(result.env, { SHELL: shell, PATH: '/inherited', KEEP: 'me' });
  assert.match(result.error!, /no environment/);
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
