import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MAX_RECORD_BYTES } from '../backend/protocol.ts';

export function client(
  command = process.execPath,
  args = ['--import', 'tsx', 'backend/main.ts'],
  cwd = resolve('.'),
  env = process.env,
) {
  const ownedSession = env.NORTUSCC_FIXTURE_SESSION
    ? null
    : mkdtempSync(resolve(tmpdir(), 'nortuscc-fixture-session-check-'));
  const sessionDirectory = env.NORTUSCC_FIXTURE_SESSION || ownedSession!;
  const child = spawn(command, args, {
    cwd,
    env: { ...env, NORTUSCC_FIXTURE_SESSION: sessionDirectory },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: any[] = [],
    diagnostics: any[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
  createInterface({ input: child.stderr }).on('line', (line) => {
    try {
      diagnostics.push(JSON.parse(line));
    } catch {}
  });
  let id = 0;
  async function until<T>(get: () => T | undefined): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < 6000) {
      const value = get();
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(
      `Timed out; messages=${JSON.stringify(messages)}, stderr=${JSON.stringify(diagnostics)}`,
    );
  }
  function send(command: string) {
    const requestId = String(++id);
    child.stdin.write(JSON.stringify({ version: 1, id: requestId, command }) + '\n');
    return until(() => messages.find((message) => message.id === requestId));
  }
  async function close() {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.stdin.end();
      await exited;
    }
    if (ownedSession) await rm(ownedSession, { recursive: true, force: true });
  }
  return { child, messages, diagnostics, until, send, close };
}
async function cleaned(resource: any) {
  await assert.rejects(access(resource.directory));
  assert.throws(() => process.kill(resource.childPid, 0));
}

test('live operation reports progress, rejects busy, cancels and cleans child and directory', async (t) => {
  const c = client();
  t.after(() => c.close());
  const started = await c.send('start');
  assert.equal(started.ok, true);
  const resource = await c.until(() => c.diagnostics.find((d) => d.event === 'resource'));
  const busy = await c.send('start');
  assert.equal(busy.error.code, 'BUSY');
  await c.until(() => c.messages.find((m) => m.state === 'running' && m.percent > 0));
  assert.equal((await c.send('cancel')).ok, true);
  const cancelled = await c.until(() => c.messages.find((m) => m.state === 'cancelled'));
  assert.equal(cancelled.operationId, started.result.operationId);
  assert.equal(cancelled.detail, 'Fixture operation cancelled');
  await cleaned(resource);
  assert.equal((await c.send('inspect')).result.diff.length, 2);
});

test('completion publishes 100 percent after cleanup and updates fixture snapshot', async (t) => {
  const c = client();
  t.after(() => c.close());
  await c.send('start');
  const resource = await c.until(() => c.diagnostics.find((d) => d.event === 'resource'));
  await c.until(() => c.messages.find((m) => m.state === 'completed' && m.percent === 100));
  await cleaned(resource);
  assert.deepEqual((await c.send('inspect')).result.diff, []);
});

for (const mode of ['eof', 'shutdown', 'crash', 'abrupt death'])
  test(`${mode} during work leaves no child or temporary directory`, async (t) => {
    const c = client();
    t.after(() => c.close());
    await c.send('start');
    const resource = await c.until(() => c.diagnostics.find((d) => d.event === 'resource'));
    const exited = once(c.child, 'exit');
    if (mode === 'eof') c.child.stdin.end();
    else if (mode === 'abrupt death') c.child.kill('SIGKILL');
    else await c.send(mode);
    await exited;
    await c.until(() => {
      try {
        process.kill(resource.childPid, 0);
      } catch {
        return true;
      }
    });
    await cleaned(resource);
  });

test('malformed and oversized records are rejected and next valid request still completes', async (t) => {
  const c = client();
  t.after(() => c.close());
  c.child.stdin.write('{broken\n' + 'x'.repeat(MAX_RECORD_BYTES + 1) + '\n');
  c.child.stdin.write(JSON.stringify({ version: 2, id: 'bad', command: 'start' }) + '\n');
  c.child.stdin.write(JSON.stringify({ version: 1, id: 'unknown', command: 'shell' }) + '\n');
  const result = await c.send('inspect');
  assert.equal(result.ok, true);
  await c.until(() => (c.messages.filter((m) => m.ok === false).length === 4 ? true : undefined));
  assert.equal(c.diagnostics.length, 0);
});

test('bundled Node and backend run from another directory without Node on PATH', async (t) => {
  const cwd = await mkdtemp(resolve(tmpdir(), 'fixture-smoke-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const root = resolve('src-tauri/resources', `${process.platform}-${process.arch}`);
  const c = client(
    resolve(root, process.platform === 'win32' ? 'node.exe' : 'node'),
    [resolve(root, 'backend.mjs')],
    cwd,
    { PATH: '' },
  );
  t.after(() => c.close());
  assert.equal((await c.send('inspect')).ok, true);
  await c.send('start');
  await c.until(() => c.messages.find((m) => m.state === 'completed'));
});

test('operation directories stay beneath the supplied session and cancel preserves that session', async (t) => {
  const session = await mkdtemp(resolve(tmpdir(), 'nortuscc-fixture-session-check-'));
  t.after(() => rm(session, { recursive: true, force: true }));
  const c = client(process.execPath, ['--import', 'tsx', 'backend/main.ts'], resolve('.'), {
    ...process.env,
    NORTUSCC_FIXTURE_SESSION: session,
  });
  t.after(() => c.close());
  await c.send('start');
  const resource = await c.until(() => c.diagnostics.find((d) => d.event === 'resource'));
  assert.equal(resolve(resource.directory, '..'), session);
  await c.send('cancel');
  await cleaned(resource);
  await access(session);
});

test('fixture child failure publishes a truthful failed state and preserves the preview', async (t) => {
  const c = client();
  t.after(() => c.close());
  await c.send('start');
  const resource = await c.until(() => c.diagnostics.find((d) => d.event === 'resource'));
  process.kill(resource.childPid, 'SIGTERM');
  const failed = await c.until(() => c.messages.find((message) => message.state === 'failed'));
  assert.equal(failed.detail, 'Fixture operation failed');
  await cleaned(resource);
  assert.equal((await c.send('inspect')).result.diff.length, 2);
});
