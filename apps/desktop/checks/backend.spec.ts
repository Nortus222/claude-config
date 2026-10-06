import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { MAX_RECORD_BYTES } from '../backend/protocol.ts';
import { appliedFile, writeFakeMachine, type FakeItem } from './support/fake-domains.ts';

// DESKTOP_RUNTIME runs the backend sources on another runtime, such as the bundled Bun.
const runtime = process.env.DESKTOP_RUNTIME;
const checkout = resolve(import.meta.dirname, '../../..');

// A temporary HOME whose state.json records this checkout, and a shell that runs the probe directly.
function home(t: TestContext, items: FakeItem[] = [], record: string | null = checkout) {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-backend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateRoot = join(dir, '.config', 'nortuscc');
  mkdirSync(stateRoot, { recursive: true });
  if (record !== null) writeFileSync(join(stateRoot, 'state.json'), JSON.stringify({ version: 1, repo: record, skillsOnly: false, files: {} }));
  writeFakeMachine(stateRoot, items);
  const shell = join(dir, 'shell');
  writeFileSync(shell, '#!/bin/sh\nexec /bin/sh -c "$2"\n');
  chmodSync(shell, 0o755);
  return { dir, stateRoot, env: { PATH: process.env.PATH ?? '', HOME: dir, SHELL: shell } };
}

function client(t: TestContext, env: Record<string, string>, entry = 'checks/support/fake-backend.ts', command?: string, args?: string[], cwd = resolve('.')) {
  const child = spawn(command ?? runtime ?? process.execPath, args ?? (runtime ? [entry] : ['--import', 'tsx', entry]), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages: any[] = [];
  const stderr: string[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
  createInterface({ input: child.stderr }).on('line', (line) => stderr.push(line));
  let id = 0;
  async function until<T>(get: () => T | undefined, ms = 10_000): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const value = get();
      if (value !== undefined) return value;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`Timed out; messages=${JSON.stringify(messages).slice(0, 2000)} stderr=${stderr.join('\n').slice(0, 2000)}`);
  }
  const send = (command: string, extra: Record<string, unknown> = {}) => {
    const requestId = String(++id);
    child.stdin.write(JSON.stringify({ version: 2, id: requestId, command, ...extra }) + '\n');
    return until(() => messages.find((m) => m.id === requestId));
  };
  const terminal = (runId: string) => until(() => messages.find((m) => m.runId === runId && ['done', 'cancelled', 'failed'].includes(m.progress.type)));
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.stdin.end();
      await exited;
    }
  };
  t.after(close);
  return { child, messages, stderr, send, terminal, until, close };
}

test('the real entry inspects and previews this checkout on a temporary HOME', async (t) => {
  const h = home(t);
  const c = client(t, h.env, 'backend/main.ts');
  const inspected = await c.send('inspect');
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.result.profile.repo, checkout);
  assert.ok(Array.isArray(inspected.result.items));
  const preview = await c.send('preview', { exclude: [] });
  assert.equal(preview.ok, true);
  assert.equal(preview.result.plan.kind, 'apply');
});

test('the real entry names a stale recorded checkout', async (t) => {
  const c = client(t, home(t, [], '/nonexistent/claude-config').env, 'backend/main.ts');
  const reply = await c.send('inspect');
  assert.equal(reply.error.code, 'REPO_NOT_FOUND');
  assert.match(reply.error.message, /\/nonexistent\/claude-config.*nortuscc setup --dir/);
});

test('apply replies before its events and runs the plan to done', async (t) => {
  const h = home(t, [{ key: 'config:a', disposition: 'apply' }, { key: 'config:b', disposition: 'apply' }]);
  const c = client(t, h.env);
  await c.send('inspect');
  const preview = await c.send('preview', { exclude: [] });
  const applied = await c.send('apply', { planId: preview.result.planId });
  assert.equal(applied.result.status, 'started');
  const done = await c.terminal(applied.result.runId);
  assert.equal(done.progress.type, 'done');
  const run = c.messages.filter((m) => m.runId === applied.result.runId).map((m) => m.progress.type);
  assert.deepEqual(run, ['started', 'finished', 'started', 'finished', 'done']);
  assert.ok(c.messages.indexOf(applied) < c.messages.findIndex((m) => m.runId === applied.result.runId));
  assert.equal(readFileSync(appliedFile(h.stateRoot, 'config:b'), 'utf8'), 'applied\n');
  assert.ok((await c.send('inspect')).result.items.every((i: any) => i.disposition === 'in-sync'));
});

test('a step note above the record limit is truncated and the run completes', async (t) => {
  const h = home(t, [{ key: 'config:loud', disposition: 'apply', behavior: 'loud' }, { key: 'config:b', disposition: 'apply' }]);
  const c = client(t, h.env);
  await c.send('inspect');
  const applied = await c.send('apply', { planId: (await c.send('preview', { exclude: [] })).result.planId });
  assert.deepEqual((await c.terminal(applied.result.runId)).progress, { type: 'done', ok: 1, failed: 1 });
  const finished = c.messages.find((m) => m.runId === applied.result.runId && m.progress.key === 'config:loud' && m.progress.type === 'finished');
  assert.equal(finished.progress.outcome, 'failed');
  assert.ok(finished.progress.note.length > 0 && finished.progress.note.length <= 4096, `note length ${finished.progress.note.length}`);
});

test('busy rejection, cancel, and a released lock', async (t) => {
  const h = home(t, [{ key: 'config:slow', disposition: 'apply', behavior: 'slow' }, { key: 'config:b', disposition: 'apply' }]);
  const c = client(t, h.env);
  await c.send('inspect');
  const applied = await c.send('apply', { planId: (await c.send('preview', { exclude: [] })).result.planId });
  await c.until(() => c.messages.find((m) => m.runId === applied.result.runId && m.progress.type === 'started'));
  assert.equal((await c.send('inspect')).error.code, 'BUSY');
  assert.equal((await c.send('apply', { planId: 'x' })).error.code, 'BUSY');
  assert.deepEqual((await c.send('cancel')).result, { cancelled: true });
  const end = await c.terminal(applied.result.runId);
  assert.deepEqual(end.progress, { type: 'cancelled', remaining: ['config:b'] });
  assert.equal(existsSync(join(h.stateRoot, 'apply.lock')), false);
});

test('a stale preview is refused with the new preview', async (t) => {
  const h = home(t, [{ key: 'config:a', disposition: 'apply' }]);
  const c = client(t, h.env);
  await c.send('inspect');
  const first = await c.send('preview', { exclude: [] });
  writeFakeMachine(h.stateRoot, [{ key: 'config:a', disposition: 'apply' }, { key: 'config:new', disposition: 'apply' }]);
  const stale = await c.send('apply', { planId: first.result.planId });
  assert.equal(stale.result.status, 'stale');
  assert.deepEqual(stale.result.plan.steps.map((s: any) => s.key), ['config:a', 'config:new']);
  assert.equal(c.messages.some((m) => m.event === 'progress'), false);
  assert.equal((await c.send('apply', { planId: first.result.planId })).error.code, 'UNKNOWN_PLAN');
  assert.equal((await c.send('preview', { exclude: ['config:nope'] })).error.code, 'UNKNOWN_KEY');
});

test('shutdown and EOF mid-apply finish the current file step and release the lock', async (t) => {
  for (const mode of ['shutdown', 'eof'] as const) {
    const h = home(t, [{ key: 'config:sleepy', disposition: 'apply', behavior: 'sleepy' }, { key: 'config:b', disposition: 'apply' }]);
    const c = client(t, h.env);
    await c.send('inspect');
    const applied = await c.send('apply', { planId: (await c.send('preview', { exclude: [] })).result.planId });
    await c.until(() => c.messages.find((m) => m.runId === applied.result.runId && m.progress.type === 'started'));
    const exited = once(c.child, 'exit');
    if (mode === 'shutdown') c.child.stdin.write(JSON.stringify({ version: 2, id: 'bye', command: 'shutdown' }) + '\n');
    else c.child.stdin.end();
    assert.equal((await exited)[0], 0, mode);
    assert.equal(readFileSync(appliedFile(h.stateRoot, 'config:sleepy'), 'utf8'), 'applied\n', mode);
    assert.equal(existsSync(appliedFile(h.stateRoot, 'config:b')), false, mode);
    assert.equal(existsSync(join(h.stateRoot, 'apply.lock')), false, mode);
  }
});

test('an abruptly killed backend leaves a lock the next run takes over', async (t) => {
  const h = home(t, [{ key: 'config:slow', disposition: 'apply', behavior: 'slow' }]);
  const first = client(t, h.env);
  await first.send('inspect');
  const applied = await first.send('apply', { planId: (await first.send('preview', { exclude: [] })).result.planId });
  await first.until(() => first.messages.find((m) => m.runId === applied.result.runId && m.progress.type === 'started'));
  const exited = once(first.child, 'exit');
  first.child.kill('SIGKILL');
  await exited;
  assert.equal(existsSync(join(h.stateRoot, 'apply.lock')), true);
  writeFakeMachine(h.stateRoot, [{ key: 'config:a', disposition: 'apply' }]);
  const second = client(t, h.env);
  await second.send('inspect');
  const again = await second.send('apply', { planId: (await second.send('preview', { exclude: [] })).result.planId });
  assert.equal((await second.terminal(again.result.runId)).progress.type, 'done');
});

test('a report far above the old 16 KB cap round-trips', async (t) => {
  const items = Array.from({ length: 2000 }, (_, i) => ({ key: `config:item-${i}`, disposition: 'in-sync' as const }));
  const c = client(t, home(t, items).env);
  const inspected = await c.send('inspect');
  assert.equal(inspected.result.items.length, 2000);
  assert.ok(JSON.stringify(inspected).length > 16_384);
});

test('malformed, oversized, v1, unknown and path-carrying records are rejected; the next request works', async (t) => {
  const c = client(t, home(t).env);
  c.child.stdin.write('{broken\n' + 'x'.repeat(MAX_RECORD_BYTES + 1) + '\n');
  c.child.stdin.write(JSON.stringify({ version: 1, id: 'v1', command: 'inspect' }) + '\n');
  c.child.stdin.write(JSON.stringify({ version: 2, id: 'crash', command: 'crash' }) + '\n');
  c.child.stdin.write(JSON.stringify({ version: 2, id: 'path', command: 'inspect', path: '/etc' }) + '\n');
  assert.equal((await c.send('inspect')).ok, true);
  const failures = await c.until(() => (c.messages.filter((m) => m.ok === false).length === 5 ? c.messages.filter((m) => m.ok === false) : undefined));
  assert.deepEqual(failures.map((m) => m.error.code).sort(), ['INVALID_REQUEST', 'INVALID_REQUEST', 'INVALID_REQUEST', 'MALFORMED', 'OVERSIZED']);
});

test('the bundled Bun backend runs from another directory with an empty PATH', async (t) => {
  const root = resolve('src-tauri/resources', `${process.platform}-${process.arch}`);
  const h = home(t);
  const cwd = mkdtempSync(join(tmpdir(), 'nortuscc-bundled-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const c = client(t, { PATH: '', HOME: h.dir }, undefined, join(root, 'bun'), [join(root, 'backend.mjs')], cwd);
  const inspected = await c.send('inspect');
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.result.profile.repo, checkout);
});

test('a closed stdout shuts down like EOF: the current step finishes and the lock is released', async (t) => {
  const h = home(t, [{ key: 'config:sleepy', disposition: 'apply', behavior: 'sleepy' }, { key: 'config:b', disposition: 'apply' }]);
  const c = client(t, h.env);
  await c.send('inspect');
  const applied = await c.send('apply', { planId: (await c.send('preview', { exclude: [] })).result.planId });
  await c.until(() => c.messages.find((m) => m.runId === applied.result.runId && m.progress.type === 'started'));
  const exited = once(c.child, 'exit');
  c.child.stdout.destroy();
  assert.equal((await exited)[0], 0, c.stderr.join('\n'));
  assert.equal(readFileSync(appliedFile(h.stateRoot, 'config:sleepy'), 'utf8'), 'applied\n');
  // A broken pipe is only noticed on the next write, so the following step may already have begun.
  assert.equal(existsSync(join(h.stateRoot, 'apply.lock')), false);
});
