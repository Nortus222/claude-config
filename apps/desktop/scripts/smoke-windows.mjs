import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RECORD_BYTES, decodeMessage } from '@nortuscc/agent/ipc/protocol';
import { agentEndpoint } from '@nortuscc/sync/agent-endpoint';

// Windows smoke (ADR 0040): a foreground bundled agent on a throwaway profile, a raw hello over its
// named pipe and, given the built exe, its `--smoke`. Usage: smoke-windows.mjs [path to the built exe];
// resources are `agent-runtime\` beside the exe, else DESKTOP_AGENT_RESOURCES, else resources\win32-x64.
// Every process gets TEMP, the profile and APPDATA inside one temporary root, removed at the end.
if (process.platform !== 'win32') throw new Error('smoke-windows.mjs runs on Windows only; use smoke.mjs elsewhere');
const root = fileURLToPath(new URL('..', import.meta.url));
const exe = process.argv[2] ? resolve(process.argv[2]) : null;
const resources = exe ? join(dirname(exe), 'agent-runtime')
  : resolve(process.env.DESKTOP_AGENT_RESOURCES ?? join(root, 'src-tauri/resources/win32-x64'));
// The native smoke requires its HOME strictly inside the temp dir, so TEMP is the root itself.
const temporaryRoot = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'ncc-win-')));
const home = join(temporaryRoot, 'home');
const appData = join(home, 'AppData', 'Roaming');
const cwd = join(home, 'cwd');
const repo = join(home, 'repo');
const origin = join(home, 'origin.git');
const stateRoot = join(appData, 'nortuscc');
const agentDir = join(stateRoot, 'agent');

const gitExe = execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/).find((line) => line.endsWith('.exe'));
assert.ok(gitExe, 'git.exe must be on PATH');
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const inherited = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME'];
const env = {
  ...Object.fromEntries(inherited.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
  // Git, and PowerShell for the private-file ACL helpers; no agent CLIs are reachable.
  PATH: [dirname(gitExe), join(systemRoot, 'System32'), join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
  USERPROFILE: home, HOME: home, APPDATA: appData, LOCALAPPDATA: join(home, 'AppData', 'Local'),
  TEMP: temporaryRoot, TMP: temporaryRoot, NORTUSCC_DESKTOP_LOCAL_ONLY: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL',
};
const git = (...args) => execFileSync(gitExe, args, { cwd: repo, env, encoding: 'utf8' }).trim();
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const until = async (get, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = get();
    if (value !== undefined && value !== false) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('Smoke timed out');
};

const sockets = new Set();
async function connect() {
  const socket = createConnection(agentEndpoint(agentDir, 'win32'));
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
    } catch (error) {
      failure = error;
      socket.destroy();
    }
  });
  socket.on('error', () => {});
  let next = 0;
  const send = (command, extra = {}) => {
    const id = String(++next);
    socket.write(JSON.stringify({ version: 3, id, command, ...extra }) + '\n');
    return until(() => {
      if (failure) throw failure;
      const found = messages.find((message) => message.id === id);
      if (found) return found;
      assert.equal(socket.destroyed, false, 'pipe closed while smoke was waiting for a record');
    });
  };
  const hello = () => send('hello', { token: readFileSync(join(agentDir, 'agent.token'), 'utf8').trim(), client: 'app' });
  return { socket, send, hello };
}

const stopChild = async (child, exited) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await exited;
};
let agent;
let agentExited;
let native;
let nativeExited;
let stderr = '';
let stdout = '';
try {
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  // No plugins, skills, hooks or MCP servers. The sole effect is copying inert config into the profile.
  write(join(repo, 'claude/CLAUDE.md'), '# Smoke fixture\n');
  write(join(repo, 'codex/AGENTS.md'), '# Smoke fixture\n');
  write(join(repo, 'claude/settings.keys.json'), JSON.stringify({ theme: 'dark' }));
  write(join(repo, 'integrations.json'), JSON.stringify({ version: 1, integrations: [] }));
  write(join(repo, 'skills-manifest.txt'), '');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Smoke fixture');
  git('config', 'user.email', 'smoke@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '-qm', 'Inert smoke fixture');
  git('init', '-q', '--bare', '-b', 'main', origin);
  git('remote', 'add', 'origin', origin);
  git('push', '-qu', 'origin', 'main');
  write(join(stateRoot, 'state.json'), JSON.stringify({ version: 1, repo, files: {} }));
  write(join(agentDir, 'agent.json'), JSON.stringify({ version: 1, policy: 'manual', policySource: 'person', paused: null }));
  write(join(agentDir, 'setups.json'), JSON.stringify({ version: 1, setups: [{ setupId: null, repoUrl: origin.replace(/\.git$/, ''), checkout: repo, trustedAt: new Date().toISOString() }] }));

  const started = Date.now();
  agent = spawn(join(resources, 'bun.exe'), [join(resources, 'agent.mjs')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  agent.stdout.on('data', (chunk) => { stdout += chunk; });
  agent.stderr.on('data', (chunk) => { stderr += chunk; });
  let launchError;
  agent.once('error', (error) => { launchError = error; });
  agentExited = new Promise((done) => agent.once('close', (...result) => done(result)));
  await until(() => {
    if (launchError) throw launchError;
    assert.equal(agent.exitCode, null, stderr);
    return existsSync(join(agentDir, 'agent.pipe')) && existsSync(join(agentDir, 'agent.token'));
  });
  console.log(`Agent listening on ${readFileSync(join(agentDir, 'agent.pipe'), 'utf8').trim()} after ${Date.now() - started} ms`);
  let client = await connect();
  const hello = await client.hello();
  assert.equal(hello.ok, true, JSON.stringify(hello));
  assert.equal(hello.result.protocol, 3);
  assert.equal(hello.result.agentVersion, JSON.parse(readFileSync(join(resources, 'runtime.json'), 'utf8')).agentVersion);
  console.log('Raw hello passed');

  if (exe) {
    native = spawn(exe, ['--smoke', home], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let nativeError;
    native.once('error', (error) => { nativeError = error; });
    nativeExited = new Promise((done) => native.once('close', (...result) => done(result)));
    let output = '';
    native.stdout.on('data', (chunk) => { output += chunk; });
    native.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => native.kill(), 180_000);
    try {
      const result = await nativeExited;
      if (nativeError) throw nativeError;
      assert.equal(result[0], 0, output);
      assert.match(output, /Packaged Rust owner smoke passed/);
      process.stdout.write(output);
    } finally { clearTimeout(timer); }
    assert.equal(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8'), '# Smoke fixture\n');
    assert.equal(agent.exitCode, null, 'native exit stopped the foreground agent');
    client.socket.destroy();
    client = await connect();
    assert.equal((await client.hello()).ok, true);
  }

  const shutdown = await client.send('shutdown');
  assert.equal(shutdown.ok, true, JSON.stringify(shutdown));
  assert.equal((await agentExited)[0], 0, stderr);
  assert.equal(stdout, '', 'foreground agent wrote helper output');
  assert.equal(existsSync(join(agentDir, 'agent.pipe')), false, 'agent.pipe was left behind');
  assert.equal(existsSync(join(agentDir, 'agent.token')), false, 'agent.token was left behind');
  console.log(`${exe ? 'Packaged Rust owner' : 'Bundled agent'} Windows smoke passed on temporary root ${temporaryRoot}`);
} finally {
  for (const socket of sockets) socket.destroy();
  try {
    await stopChild(native, nativeExited);
    await stopChild(agent, agentExited);
  } finally { rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
