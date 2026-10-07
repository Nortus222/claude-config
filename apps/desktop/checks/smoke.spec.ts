import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';

const unixSmokeSkip = process.platform === 'win32' ? 'requires POSIX smoke tools and Unix agent IPC (ADR 0019)' : false;
const resourceSkip = unixSmokeSkip || (process.env.DESKTOP_AGENT_RESOURCES === undefined ? 'set DESKTOP_AGENT_RESOURCES after bundling' : false);

type RecordedChild = { pid: number; home: string };

async function stopRecordedChild(child: RecordedChild) {
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, 'fixture record must name a child PID');
  const alive = () => {
    try { process.kill(child.pid, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!alive()) break;
    try { process.kill(child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    const deadline = Date.now() + 5000;
    while (alive() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(alive(), false, `fixture child ${child.pid} did not stop; retaining its files`);
}

async function cleanupRecordedFixture(app: string, record: string, child?: RecordedChild) {
  child ??= existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) as RecordedChild : undefined;
  if (child) {
    await stopRecordedChild(child);
    rmSync(child.home, { recursive: true, force: true });
  }
  rmSync(app, { recursive: true, force: true });
}

// Unix socket paths need a short root; ownership stays outside HOME for reliable teardown.
function smokeFixture(t: TestContext) {
  const root = mkdtempSync('/tmp/nsm-');
  const app = join(root, 'app');
  const temporaryRoot = join(root, 'tmp');
  const record = join(root, 'children.json');
  const fallbackRecords: string[] = [];
  mkdirSync(app);
  mkdirSync(temporaryRoot);
  const cleanup = async () => {
    const owned = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) as { home: string; pids: number[] } : undefined;
    const children = fallbackRecords.filter(existsSync).map((path) => JSON.parse(readFileSync(path, 'utf8')) as RecordedChild);
    if (owned) children.push(...owned.pids.map((pid) => ({ pid, home: owned.home })));
    for (const child of children) {
      assert.ok(child.home.startsWith(realpathSync(temporaryRoot) + '/ncc-'), 'child HOME must belong to this fixture');
      // Stop every child before removing any of their resources or HOME.
      await stopRecordedChild(child);
    }
    rmSync(root, { recursive: true, force: true });
  };
  t.after(cleanup);
  return { root, app, temporaryRoot, record, fallbackRecords, cleanup,
    env: { ...process.env, TMPDIR: temporaryRoot, NORTUSCC_DESKTOP_SMOKE_RECORD: record } };
}

test('bundled smoke exercises authenticated socket operations and rejects unsafe records on an inert setup', {
  skip: resourceSkip,
  timeout: 60_000,
}, async (t) => {
  const f = smokeFixture(t);
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/smoke.mjs'], { cwd: new URL('..', import.meta.url), env: f.env, timeout: 55_000 });
  assert.match(stdout, /Socket refusals passed/);
  assert.match(stdout, /Apply and cancel passed/);
  assert.match(stdout, /Bundled agent smoke passed/);
});

test('smoke waits for its foreground child to stop and removes HOME when a socket record fails validation', {
  skip: resourceSkip,
  timeout: 15_000,
}, async (t) => {
  const app = mkdtempSync('/tmp/nsm-');
  const resources = join(app, 'Contents/Resources/agent-runtime');
  const record = join(app, 'child.json');
  let child: RecordedChild | undefined;
  t.after(() => cleanupRecordedFixture(app, record, child));
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
  skip: resourceSkip,
  timeout: 20_000,
}, async (t) => {
  const f = smokeFixture(t);
  const { app, temporaryRoot } = f;
  const resources = join(app, 'Contents/Resources/agent-runtime');
  const native = join(app, 'Contents/MacOS/nortuscc-desktop-validation');
  const record = join(app, 'native-env');
  mkdirSync(resources, { recursive: true });
  mkdirSync(join(app, 'Contents/MacOS'));
  for (const file of ['bun', 'agent.mjs', 'runtime.json']) {
    symlinkSync(join(resolve(process.env.DESKTOP_AGENT_RESOURCES!), file), join(resources, file));
  }
  writeFileSync(native, `#!/bin/sh\nprintf '%s\\n' "$TMPDIR" "$HOME" > '${record}'\nprintf 'Packaged Rust owner smoke passed\\n'\n`);
  chmodSync(native, 0o755);
  await promisify(execFile)(process.execPath, ['scripts/smoke.mjs', app], {
    cwd: new URL('..', import.meta.url), env: f.env, timeout: 15_000,
  });
  const [nativeTemporaryRoot, nativeHome] = readFileSync(record, 'utf8').trimEnd().split('\n');
  assert.equal(nativeTemporaryRoot, realpathSync(temporaryRoot));
  assert.ok(nativeHome.startsWith(nativeTemporaryRoot + '/ncc-'));
  assert.equal(existsSync(nativeHome), false);
});

for (const code of ['ENOENT', 'EACCES']) {
  test(`smoke removes its temporary HOME when the bundled runtime cannot launch (${code})`, { skip: unixSmokeSkip, timeout: 10_000 }, async (t) => {
    const app = mkdtempSync('/tmp/nsm-');
    t.after(() => rmSync(app, { recursive: true, force: true }));
    const resources = join(app, 'Contents/Resources/agent-runtime');
    const temporaryRoot = join(app, 'tmp');
    mkdirSync(resources, { recursive: true });
    mkdirSync(temporaryRoot);
    if (code === 'EACCES') writeFileSync(join(resources, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    await assert.rejects(promisify(execFile)(process.execPath, ['scripts/smoke.mjs', app], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, TMPDIR: temporaryRoot }, timeout: 5000,
    }), (error: unknown) => {
      const failure = error as { code: number; stderr: string; killed: boolean };
      assert.equal(failure.code, 1);
      assert.equal(failure.killed, false);
      assert.match(failure.stderr, new RegExp(code));
      return true;
    });
    assert.deepEqual(readdirSync(temporaryRoot), [], 'smoke left its temporary HOME behind');
  });
}

test('a missing native executable stops the foreground agent and removes HOME', {
  skip: resourceSkip,
  timeout: 20_000,
}, async (t) => {
  const app = mkdtempSync('/tmp/nsm-');
  const resources = join(app, 'Contents/Resources/agent-runtime');
  const temporaryRoot = join(app, 'tmp');
  const record = join(app, 'child.json');
  let child: RecordedChild | undefined;
  t.after(() => cleanupRecordedFixture(app, record, child));
  mkdirSync(resources, { recursive: true });
  mkdirSync(temporaryRoot);
  for (const file of ['bun', 'runtime.json']) {
    symlinkSync(join(resolve(process.env.DESKTOP_AGENT_RESOURCES!), file), join(resources, file));
  }
  writeFileSync(join(resources, 'agent.mjs'), `
import { writeFileSync } from 'node:fs';
import { runDesktopEntry } from ${JSON.stringify(join(resolve(process.env.DESKTOP_AGENT_RESOURCES!), 'agent.mjs'))};
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, home: process.env.HOME }));
process.exitCode = await runDesktopEntry({ args: [], env: process.env, resources: ${JSON.stringify(resources)} });
`);
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/smoke.mjs', app], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, TMPDIR: temporaryRoot }, timeout: 15_000,
  }), /ENOENT/);
  child = JSON.parse(readFileSync(record, 'utf8'));
  assert.throws(() => process.kill(child!.pid, 0), { code: 'ESRCH' });
  assert.equal(existsSync(child!.home), false);
  assert.deepEqual(readdirSync(temporaryRoot), []);
});

test('fixture teardown discovers and joins its child after smoke times out', {
  skip: resourceSkip,
  timeout: 15_000,
}, async (t) => {
  const app = mkdtempSync('/tmp/nsm-');
  const resources = join(app, 'Contents/Resources/agent-runtime');
  const temporaryRoot = join(app, 'tmp');
  const record = join(app, 'child.json');
  let child: RecordedChild | undefined;
  t.after(() => cleanupRecordedFixture(app, record, child));
  mkdirSync(resources, { recursive: true });
  mkdirSync(temporaryRoot);
  symlinkSync(join(resolve(process.env.DESKTOP_AGENT_RESOURCES!), 'bun'), join(resources, 'bun'));
  writeFileSync(join(resources, 'agent.mjs'), `
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = join(process.env.HOME, '.config/nortuscc/agent');
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, home: process.env.HOME }));
writeFileSync(join(dir, 'agent.token'), 'fixture');
createServer(() => {}).listen(join(dir, 'agent.sock'));
`);
  // The fixture accepts the socket but never answers hello, so execFile kills only the smoke parent.
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/smoke.mjs', app], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, TMPDIR: temporaryRoot }, timeout: 3000,
  }), (error: unknown) => (error as { killed?: boolean }).killed === true);
  child = JSON.parse(readFileSync(record, 'utf8'));
  assert.doesNotThrow(() => process.kill(child!.pid, 0), 'timeout should leave the fixture child for teardown');
  // No cached child is passed: teardown must discover ownership from its own record.
  await cleanupRecordedFixture(app, record);
  assert.throws(() => process.kill(child!.pid, 0), { code: 'ESRCH' });
  assert.equal(existsSync(child!.home), false);
  assert.equal(existsSync(app), false);
});

test('ordinary packaged smoke timeout discovers and stops both genuine agent and native child before removing files', {
  skip: resourceSkip,
  timeout: 20_000,
}, async (t) => {
  const f = smokeFixture(t);
  const resources = join(f.app, 'Contents/Resources/agent-runtime');
  const native = join(f.app, 'Contents/MacOS/nortuscc-desktop-validation');
  const agentRecord = join(f.root, 'agent-fallback.json');
  const nativeRecord = join(f.root, 'native-fallback.json');
  f.fallbackRecords.push(agentRecord, nativeRecord);
  mkdirSync(resources, { recursive: true });
  mkdirSync(join(f.app, 'Contents/MacOS'));
  for (const file of ['bun', 'runtime.json']) symlinkSync(join(resolve(process.env.DESKTOP_AGENT_RESOURCES!), file), join(resources, file));
  writeFileSync(join(resources, 'agent.mjs'), `
import { writeFileSync } from 'node:fs';
import { runDesktopEntry } from ${JSON.stringify(join(resolve(process.env.DESKTOP_AGENT_RESOURCES!), 'agent.mjs'))};
writeFileSync(${JSON.stringify(agentRecord)}, JSON.stringify({ pid: process.pid, home: process.env.HOME }));
process.exitCode = await runDesktopEntry({ args: [], env: process.env, resources: ${JSON.stringify(resources)} });
`);
  writeFileSync(native, `#!/bin/sh\nprintf '{"pid":%s,"home":"%s"}' "$$" "$HOME" > '${nativeRecord}'\nexec /bin/sleep 30\n`);
  chmodSync(native, 0o755);
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/smoke.mjs', f.app], {
    cwd: new URL('..', import.meta.url), env: f.env, timeout: 6000,
  }), (error: unknown) => (error as { killed?: boolean }).killed === true);
  const agent = JSON.parse(readFileSync(agentRecord, 'utf8')) as RecordedChild;
  const nativeChild = JSON.parse(readFileSync(nativeRecord, 'utf8')) as RecordedChild;
  assert.doesNotThrow(() => process.kill(agent.pid, 0));
  assert.doesNotThrow(() => process.kill(nativeChild.pid, 0));
  assert.deepEqual(JSON.parse(readFileSync(f.record, 'utf8')), { home: agent.home, pids: [agent.pid, nativeChild.pid] });
  f.fallbackRecords.length = 0;
  await f.cleanup();
  for (const child of [agent, nativeChild]) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  assert.equal(existsSync(agent.home), false);
  assert.equal(existsSync(f.root), false);
});

test('ordinary bundled smoke teardown survives parent timeout and an assertion failure before child discovery', {
  skip: resourceSkip,
  timeout: 15_000,
}, async (t) => {
  const f = smokeFixture(t);
  const resources = join(f.app, 'Contents/Resources/agent-runtime');
  const fallback = join(f.root, 'agent-fallback.json');
  f.fallbackRecords.push(fallback);
  mkdirSync(resources, { recursive: true });
  symlinkSync(join(resolve(process.env.DESKTOP_AGENT_RESOURCES!), 'bun'), join(resources, 'bun'));
  writeFileSync(join(resources, 'agent.mjs'), `
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = join(process.env.HOME, '.config/nortuscc/agent');
writeFileSync(${JSON.stringify(fallback)}, JSON.stringify({ pid: process.pid, home: process.env.HOME }));
writeFileSync(join(dir, 'agent.token'), 'fixture');
createServer(() => {}).listen(join(dir, 'agent.sock'));
`);
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/smoke.mjs'], {
    cwd: new URL('..', import.meta.url), env: { ...f.env, DESKTOP_AGENT_RESOURCES: resources }, timeout: 3000,
  }), (error: unknown) => (error as { killed?: boolean }).killed === true);
  const child = JSON.parse(readFileSync(fallback, 'utf8')) as RecordedChild;
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  assert.deepEqual(JSON.parse(readFileSync(f.record, 'utf8')), { home: child.home, pids: [child.pid] });
  f.fallbackRecords.length = 0;
  // The finally discovers records from disk even though the simulated assertion never loads one.
  await assert.rejects(async () => {
    try { assert.fail('earlier smoke assertion failed'); }
    finally { await f.cleanup(); }
  }, /earlier smoke assertion failed/);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  assert.equal(existsSync(child.home), false);
  assert.equal(existsSync(f.root), false);
});
