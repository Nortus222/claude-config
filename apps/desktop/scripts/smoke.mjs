import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RECORD_BYTES, decodeMessage } from '@nortuscc/agent/ipc/protocol';

// Only foreground agents run here. Service registration and the owner's checkout are never used.
const root = fileURLToPath(new URL('..', import.meta.url));
const app = process.argv[2] ? resolve(process.argv[2]) : null;
const resources = app ? join(app, 'Contents/Resources/agent-runtime') : join(root, 'src-tauri/resources/darwin-arm64');
const temporaryRoot = realpathSync(tmpdir());
const home = realpathSync(mkdtempSync(join(temporaryRoot, 'ncc-')));
const cwd = join(home, 'cwd');
const repo = join(home, 'repo');
const origin = join(home, 'origin.git');
const stateRoot = join(home, '.config/nortuscc');
const agentDir = join(stateRoot, 'agent');
const tools = join(home, 'tools');
const gate = join(home, 'gate');
const blocked = join(home, 'blocked');
const fifo = join(home, 'release');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const env = { HOME: home, PATH: '', TMPDIR: temporaryRoot, SHELL: join(home, 'shell'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const until = async (get, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = get();
    if (value !== undefined && value !== false) return value;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('Smoke timed out');
};

const sockets = new Set();
async function connect() {
  const socket = createConnection(join(agentDir, 'agent.sock'));
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  await once(socket, 'connect');
  const messages = [];
  let buffer = Buffer.alloc(0);
  let failure;
  socket.on('data', (chunk) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      let end;
      while ((end = buffer.indexOf(10)) >= 0) {
        assert.ok(end + 1 <= MAX_RECORD_BYTES, 'agent returned an oversized record');
        messages.push(decodeMessage(JSON.parse(buffer.subarray(0, end).toString('utf8'))));
        buffer = buffer.subarray(end + 1);
      }
      assert.ok(buffer.length < MAX_RECORD_BYTES, 'agent returned an unbounded record');
    } catch (error) {
      failure = error;
      socket.destroy();
    }
  });
  socket.on('error', () => {});
  const waitFor = (get) => until(() => {
    if (failure) throw failure;
    const result = get();
    if (result !== undefined) return result;
    assert.equal(socket.destroyed, false, 'socket closed while smoke was waiting for a record');
  });
  let next = 0;
  const send = async (command, extra = {}) => {
    const id = String(++next);
    socket.write(JSON.stringify({ version: 3, id, command, ...extra }) + '\n');
    return waitFor(() => messages.find((message) => message.id === id));
  };
  const request = async (command, extra = {}) => {
    const response = await send(command, extra);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result;
  };
  const hello = () => request('hello', { token: readFileSync(join(agentDir, 'agent.token'), 'utf8').trim(), client: 'app' });
  const terminal = (runId) => waitFor(() => messages.find((message) => message.runId === runId && ['done', 'cancelled', 'failed'].includes(message.progress.type)));
  return { socket, messages, send, request, hello, terminal };
}

let child;
let exited;
let launchError;
let stderr = '';
let stdout = '';
let gateReached = false;
async function releaseGate() {
  if (!gateReached) return;
  gateReached = false;
  await writeFile(fifo, 'release\n');
}
async function stop() {
  await releaseGate();
  for (const socket of sockets) socket.destroy();
  if (!child) return;
  let timer;
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  }
  try { await exited; } finally { clearTimeout(timer); }
}

try {
  mkdirSync(cwd);
  mkdirSync(repo);
  mkdirSync(agentDir, { recursive: true });
  // No plugins, skills, hooks or MCP servers. The sole effect is copying inert config into HOME.
  write(join(repo, 'claude/CLAUDE.md'), '# Smoke fixture\n');
  write(join(repo, 'codex/AGENTS.md'), '# Smoke fixture\n');
  write(join(repo, 'claude/settings.keys.json'), JSON.stringify({ theme: 'dark' }));
  write(join(repo, 'integrations.json'), JSON.stringify({ version: 1, integrations: [] }));
  write(join(repo, 'skills-manifest.txt'), '');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Smoke fixture');
  git('config', 'user.email', 'smoke@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  git('add', '.');
  git('commit', '-qm', 'Inert smoke fixture');
  git('init', '-q', '--bare', '-b', 'main', origin);
  git('remote', 'add', 'origin', origin);
  git('push', '-qu', 'origin', 'main');
  write(join(stateRoot, 'state.json'), JSON.stringify({ version: 1, repo, files: {} }));
  write(join(agentDir, 'agent.json'), JSON.stringify({ version: 1, policy: 'manual', policySource: 'person', paused: null }));
  write(join(agentDir, 'setups.json'), JSON.stringify({ version: 1, setups: [{ setupId: null, repoUrl: origin.replace(/\.git$/, ''), checkout: repo, trustedAt: new Date().toISOString() }] }));
  // Block one Git read during apply's re-inspection so cancel does not race an instant file step.
  execFileSync('/usr/bin/mkfifo', [fifo], { env });
  write(join(tools, 'git'), `#!/bin/sh\nif [ -f ${quote(gate)} ]; then\n  /bin/rm ${quote(gate)}\n  /usr/bin/touch ${quote(blocked)}\n  /bin/cat ${quote(fifo)} >/dev/null\nfi\nexec /usr/bin/git "$@"\n`);
  chmodSync(join(tools, 'git'), 0o755);
  write(env.SHELL, `#!/bin/sh\nexport PATH=${quote(tools)}\nexec /bin/sh -c "$2"\n`);
  chmodSync(env.SHELL, 0o755);
  child = spawn(join(resources, 'bun'), [join(resources, 'agent.mjs')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', (error) => { launchError = error; });
  // Close always follows spawn error or exit. Its join cannot reject before startup is awaited.
  exited = new Promise((done) => child.once('close', (...result) => done(result)));
  await until(() => {
    if (launchError) throw launchError;
    assert.equal(child.exitCode, null, stderr);
    return existsSync(join(agentDir, 'agent.sock')) && existsSync(join(agentDir, 'agent.token'));
  });
  let client = await connect();
  assert.equal((await client.hello()).agentVersion, JSON.parse(readFileSync(join(resources, 'runtime.json'), 'utf8')).agentVersion);
  await client.request('subscribe');
  const inspected = await client.request('inspect');
  assert.equal(inspected.profile.repo, repo);
  assert.equal(inspected.status.policy, 'manual');
  assert.ok(inspected.items.length > 0);
  const preview = await client.request('preview', { exclude: [] });
  assert.ok(preview.plan.steps.length > 0);
  assert.ok(preview.plan.steps.every((step) => step.domain === 'config'), 'fixture may apply only config');
  const applied = await client.request('apply', { planId: preview.planId });
  assert.equal(applied.status, 'started');
  const done = await client.terminal(applied.runId);
  assert.equal(done.progress.type, 'done', JSON.stringify(done));
  assert.equal(done.progress.failed, 0, JSON.stringify(done));
  assert.equal(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8'), '# Smoke fixture\n');
  assert.equal(existsSync(join(stateRoot, 'apply.lock')), false);

  assert.equal((await client.send('preview', { exclude: ['/etc/passwd'] })).error.code, 'UNKNOWN_KEY');
  assert.equal((await client.send('apply', { planId: '/etc/passwd' })).error.code, 'UNKNOWN_PLAN');
  assert.equal((await client.send('inspect', { path: '/etc' })).error.code, 'INVALID_REQUEST');
  assert.equal((await client.send('preview', { exclude: [], extra: true })).error.code, 'INVALID_REQUEST');
  assert.equal((await client.send('unknown')).error.code, 'INVALID_REQUEST');
  assert.equal((await client.send('inspect', { version: 2 })).error.code, 'INVALID_REQUEST');
  client.socket.write('{broken\n' + 'x'.repeat(MAX_RECORD_BYTES + 1) + '\n');
  await until(() => client.messages.some((message) => message.error?.code === 'MALFORMED'));
  await until(() => client.messages.some((message) => message.error?.code === 'OVERSIZED'));
  assert.equal((await client.request('status')).applying, false);
  const refused = await connect();
  const closed = once(refused.socket, 'close');
  assert.equal((await refused.send('hello', { token: 'bad-token', client: 'app' })).error.code, 'UNAUTHORIZED');
  await closed;
  const missing = await connect();
  const missingClosed = once(missing.socket, 'close');
  assert.equal((await missing.send('inspect')).error.code, 'UNAUTHORIZED');
  await missingClosed;
  console.log('Socket refusals passed');

  // Restore an inert file to missing, then cancel while apply is waiting on the fixture's Git gate.
  rmSync(join(home, '.claude/CLAUDE.md'));
  await client.request('inspect');
  const cancellation = await client.request('preview', { exclude: [] });
  write(gate, 'armed\n');
  const starting = client.request('apply', { planId: cancellation.planId });
  await until(() => existsSync(blocked));
  gateReached = true;
  const cancelled = client.request('cancel');
  // Both records share one socket; status is handled after cancel has signalled the active run.
  assert.equal((await client.request('status')).applying, true);
  await releaseGate();
  const run = await starting;
  assert.equal(run.status, 'started');
  assert.deepEqual(await cancelled, { cancelled: true });
  assert.equal((await client.terminal(run.runId)).progress.type, 'cancelled');
  assert.equal(existsSync(join(stateRoot, 'apply.lock')), false);
  assert.equal(existsSync(join(home, '.claude/CLAUDE.md')), false);
  console.log('Apply and cancel passed');

  // Closing a client must leave the foreground service serving fresh authenticated connections.
  client.socket.destroy();
  client = await connect();
  await client.hello();
  await client.request('inspect');
  if (app) {
    const native = spawn(join(app, 'Contents/MacOS/nortuscc-desktop-validation'), ['--smoke', home], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    native.stdout.on('data', (chunk) => { output += chunk; });
    native.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => native.kill('SIGKILL'), 180_000);
    try {
      assert.equal((await once(native, 'exit'))[0], 0, output);
      assert.match(output, /Packaged Rust owner smoke passed/);
    } finally { clearTimeout(timer); }
    client.socket.destroy();
    client = await connect();
    await client.hello();
    await client.request('inspect');
    assert.equal(child.exitCode, null, 'native exit stopped the foreground agent');
  }
  await client.request('shutdown');
  assert.equal((await exited)[0], 0, stderr);
  assert.equal(stdout, '', 'foreground agent wrote helper output');
  assert.equal(existsSync(join(stateRoot, 'apply.lock')), false, 'apply.lock was left behind');
  assert.equal(existsSync(join(agentDir, 'agent.sock')), false, 'agent socket was left behind');
  console.log(`${app ? 'Packaged Rust owner' : 'Bundled agent'} smoke passed on temporary HOME ${home}`);
} finally {
  try { await stop(); }
  finally { rmSync(home, { recursive: true, force: true }); }
}
