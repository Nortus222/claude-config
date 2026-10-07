import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

test('bundled smoke exercises authenticated socket operations and rejects unsafe records on an inert setup', {
  skip: process.env.DESKTOP_AGENT_RESOURCES === undefined ? 'set DESKTOP_AGENT_RESOURCES after bundling' : false,
  timeout: 60_000,
}, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/smoke.mjs'], { cwd: new URL('..', import.meta.url), timeout: 55_000 });
  assert.match(stdout, /Socket refusals passed/);
  assert.match(stdout, /Apply and cancel passed/);
  assert.match(stdout, /Bundled agent smoke passed/);
});

test('smoke waits for its foreground child to stop and removes HOME when a socket record fails validation', {
  skip: process.env.DESKTOP_AGENT_RESOURCES === undefined ? 'set DESKTOP_AGENT_RESOURCES after bundling' : false,
  timeout: 15_000,
}, async (t) => {
  const app = mkdtempSync(join(tmpdir(), 'nsm-'));
  const resources = join(app, 'Contents/Resources/agent-runtime');
  const record = join(app, 'child.json');
  let child: { pid: number; home: string } | undefined;
  t.after(() => {
    if (child) {
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
      rmSync(child.home, { recursive: true, force: true });
    }
    rmSync(app, { recursive: true, force: true });
  });
  mkdirSync(resources, { recursive: true });
  symlinkSync(join(resolve(process.env.DESKTOP_AGENT_RESOURCES!), 'bun'), join(resources, 'bun'));
  writeFileSync(join(resources, 'runtime.json'), JSON.stringify({ agentVersion: 'fake' }));
  writeFileSync(join(resources, 'agent.mjs'), `
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = join(process.env.HOME, '.config/nortuscc/agent');
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, home: process.env.HOME }));
writeFileSync(join(dir, 'agent.token'), 'fixture');
createServer((socket) => socket.on('data', () => socket.write('{"version":3,"unexpected":true}\\n'))).listen(join(dir, 'agent.sock'));
`);
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/smoke.mjs', app], {
    cwd: new URL('..', import.meta.url), timeout: 10_000,
  }));
  child = JSON.parse(readFileSync(record, 'utf8'));
  assert.throws(() => process.kill(child!.pid, 0), { code: 'ESRCH' });
  assert.equal(existsSync(child!.home), false);
});

test('packaged smoke passes its resolved temporary root to the native child', {
  skip: process.env.DESKTOP_AGENT_RESOURCES === undefined ? 'set DESKTOP_AGENT_RESOURCES after bundling' : false,
  timeout: 20_000,
}, async (t) => {
  const app = mkdtempSync('/tmp/nsm-');
  t.after(() => rmSync(app, { recursive: true, force: true }));
  const resources = join(app, 'Contents/Resources/agent-runtime');
  const native = join(app, 'Contents/MacOS/nortuscc-desktop-validation');
  const temporaryRoot = join(app, 'tmp');
  const record = join(app, 'native-env');
  mkdirSync(resources, { recursive: true });
  mkdirSync(join(app, 'Contents/MacOS'));
  mkdirSync(temporaryRoot);
  for (const file of ['bun', 'agent.mjs', 'runtime.json']) {
    symlinkSync(join(resolve(process.env.DESKTOP_AGENT_RESOURCES!), file), join(resources, file));
  }
  writeFileSync(native, `#!/bin/sh\nprintf '%s\\n' "$TMPDIR" "$HOME" > '${record}'\nprintf 'Packaged Rust owner smoke passed\\n'\n`);
  chmodSync(native, 0o755);
  await promisify(execFile)(process.execPath, ['scripts/smoke.mjs', app], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, TMPDIR: temporaryRoot }, timeout: 15_000,
  });
  const [nativeTemporaryRoot, nativeHome] = readFileSync(record, 'utf8').trimEnd().split('\n');
  assert.equal(nativeTemporaryRoot, realpathSync(temporaryRoot));
  assert.ok(nativeHome.startsWith(nativeTemporaryRoot + '/ncc-'));
  assert.equal(existsSync(nativeHome), false);
});
