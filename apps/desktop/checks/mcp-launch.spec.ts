import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { connectAgent } from '../../../src/agent-client.ts';

const native = process.env.DESKTOP_MCP_NATIVE_RUNTIME;
const resources = process.env.DESKTOP_AGENT_RESOURCES;
const skip = native && resources ? false : 'set DESKTOP_MCP_NATIVE_RUNTIME and DESKTOP_AGENT_RESOURCES for native launch checks';
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-native-')));
  const home = join(root, 'home'); mkdirSync(home);
  const app = join(root, 'App With Spaces.app/Contents/MacOS/Nortuscc'); mkdirSync(join(app, '..'), { recursive: true });
  copyFileSync(native!, app); chmodSync(app, 0o755);
  const payload = join(root, 'App With Spaces.app/Contents/Resources/agent-runtime'); cpSync(resources!, payload, { recursive: true });
  const state = join(home, 's');
  const shell = join(home, 'login-shell');
  writeFileSync(shell, '#!/bin/sh\n. "$HOME/login-profile"\nexec /bin/sh -c "$2"\n'); chmodSync(shell, 0o755);
  writeFileSync(join(home, 'login-profile'), '');
  const cleanups: Array<() => void | Promise<void>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); rmSync(root, { recursive: true, force: true }); });
  return { root, home, app, payload, state, shell, cleanups };
}
function open(t: TestContext, f: ReturnType<typeof fixture>, args = ['--mcp'], env: Record<string, string> = { NORTUSCC_STATE_DIR: f.state }) {
  const child = spawn(f.app, args, { cwd: '/', env: { HOME: f.home, PATH: '', SHELL: f.shell, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', buffer = '', id = 0;
  const pending = new Map<number, (record: any) => void>();
  const records: any[] = [];
  child.stdout.on('data', chunk => {
    stdout += chunk; buffer += chunk; let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { const record = JSON.parse(line); records.push(record); pending.get(record.id)?.(record); } catch {}
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<void>((done, reject) => { child.once('error', reject); child.once('close', () => done()); });
  f.cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  async function ask(method: string, params: object = {}) {
    const request = ++id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([new Promise<any>(done => {
        pending.set(request, done); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: request, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) + '\n');
      }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`native MCP timed out: ${stderr}`)), 8000); })]);
    } finally { clearTimeout(timer); pending.delete(request); }
  }
  return { child, exited, ask, records, stdout: () => stdout, stderr: () => stderr };
}
function clean(client: ReturnType<typeof open>) {
  for (const line of client.stdout().trim().split('\n').filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  assert.ok(!client.stdout().includes('stateRoot'));
}

test('native MCP starts without setup or GUI, from unrelated cwd, and EOF leaves no runtime or state writes', { skip, timeout: 15_000 }, async t => {
  const f = fixture(t), client = open(t, f);
  const tools = await client.ask('tools/list');
  assert.deepEqual(tools.result.tools.map((tool: { name: string }) => tool.name).sort(), [
    'nortuscc_inspect_profiles', 'nortuscc_inspect_share_link', 'nortuscc_author_profiles','nortuscc_machine_file','nortuscc_author_file','nortuscc_upstreams','nortuscc_discover_upstream','nortuscc_upstream_skill','nortuscc_drafts','nortuscc_draft_preview','nortuscc_gh_state','nortuscc_list_backups', 'nortuscc_agent_status', 'nortuscc_account_state', 'nortuscc_watch_sources', 'nortuscc_inspect_source_diff', 'nortuscc_pin_impact', 'nortuscc_draft_changelog', 'nortuscc_setup_review', 'nortuscc_inspect_setups', 'nortuscc_incoming_changes', 'nortuscc_prepare_trust_request', 'nortuscc_inspect_updates', 'nortuscc_inspect_intent', 'nortuscc_get_context', 'nortuscc_resolve_skill_candidate', 'nortuscc_inspect', 'nortuscc_preview_change',
    'nortuscc_apply_change', 'nortuscc_get_run', 'nortuscc_list_runs', 'nortuscc_cancel_run', 'nortuscc_abandon_run', 'nortuscc_history',
  ].sort());
  const reply = await client.ask('tools/call', { name: 'nortuscc_inspect', arguments: {} });
  assert.equal(reply.result.structuredContent.error.code, 'APP_UNAVAILABLE');
  const pid = client.child.pid!;
  assert.ok(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim().endsWith('/bun'), 'MCP must replace the native PID, never become an orphanable child');
  client.child.stdin.end(); await client.exited;
  assert.equal(client.child.exitCode, 0, client.stderr()); clean(client);
  assert.throws(() => process.kill(pid, 0));
  assert.equal(existsSync(f.state), false); assert.equal(existsSync(join(f.home, 'Library/LaunchAgents')), false);
});

test('native MCP rejects incompatible, missing and mismatched runtime before helper or state mutation', { skip, timeout: 20_000 }, async t => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => rmSync(join(f.payload, 'mcp.mjs')),
    (f: ReturnType<typeof fixture>) => writeFileSync(join(f.payload, 'mcp.mjs'), 'corrupt'),
    (f: ReturnType<typeof fixture>) => writeFileSync(join(f.payload, 'bun'), 'corrupt'),
    (f: ReturnType<typeof fixture>) => { const metadata = JSON.parse(readFileSync(join(f.payload, 'runtime.json'), 'utf8')); metadata.target = 'linux-x64'; writeFileSync(join(f.payload, 'runtime.json'), JSON.stringify(metadata)); },
  ]) {
    const f = fixture(t); mutate(f);
    writeFileSync(join(f.home, 'login-profile'), 'touch "$HOME/helper-was-run"\n');
    const client = open(t, f); client.child.stdin.end(); await client.exited;
    assert.equal(client.child.exitCode, 1); assert.equal(client.stdout(), ''); assert.ok(client.stderr().length < 600);
    assert.equal(existsSync(join(f.home, 'helper-was-run')), false); assert.equal(existsSync(f.state), false);
  }
  const f = fixture(t), extra = open(t, f, ['--mcp', '--app', '/private/fake']); extra.child.stdin.end(); await extra.exited;
  assert.equal(extra.child.exitCode, 1); assert.equal(extra.stdout(), '');
  const loose = join(f.root, 'Uninstalled'); copyFileSync(f.app, loose); chmodSync(loose, 0o755);
  const uninstalled = open(t, { ...f, app: loose }); uninstalled.child.stdin.end(); await uninstalled.exited;
  assert.equal(uninstalled.child.exitCode, 1); assert.equal(uninstalled.stdout(), '');
});

test('native MCP captures login-profile-only state root and binds each invocation to identical-metadata relocated app identity', { skip, timeout: 25_000 }, async t => {
  const f = fixture(t); mkdirSync(join(f.state, 'agent'), { recursive: true });
  writeFileSync(join(f.home, 'login-profile'), `printf 'private shell noise\\n'\nexport NORTUSCC_STATE_DIR='${f.state}'\n`);
  const metadata = JSON.parse(readFileSync(join(f.payload, 'runtime.json'), 'utf8'));
  const registration = { version: 1, installedBy: 'app', agentVersion: metadata.agentVersion, appPath: f.app };
  writeFileSync(join(f.state, 'agent/agent.json'), JSON.stringify(registration));
  writeFileSync(join(f.state, 'agent/agent.token'), 'private-fixture-token');
  let operations = 0; const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (request.command === 'hello') { assert.equal(request.token, 'private-fixture-token'); assert.equal(request.runtimeId, metadata.agentVersion); assert.equal(request.client, 'mcp'); }
        if (request.command === 'operation') operations++;
        const result = request.command === 'hello' ? { agentVersion: metadata.agentVersion, protocol: 3, policy: 'manual', paused: null, operationsProtocol: 1, app: { ownership: 'app', version: metadata.appVersion, runtimeId: metadata.agentVersion }, operations: { available: true } } : { privateFixture: true };
        socket.write(JSON.stringify({ version: 3, id: request.id, ok: true, result }) + '\n');
      }
    });
  });
  await new Promise<void>(done => server.listen(join(f.state, 'agent/agent.sock'), done));
  f.cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())); });
  const old = open(t, f, ['--mcp'], {}); await old.ask('tools/list');
  const call = (client: ReturnType<typeof open>) => client.ask('tools/call', { name: 'nortuscc_get_run', arguments: { runId: 'r' } });
  assert.equal((await call(old)).result.structuredContent.error.code, 'MALFORMED'); assert.equal(operations, 1);
  const relocatedRoot = join(f.root, 'Relocated.app'); cpSync(join(f.root, 'App With Spaces.app'), relocatedRoot, { recursive: true });
  const newApp = join(relocatedRoot, 'Contents/MacOS/Nortuscc');
  assert.deepEqual(readFileSync(join(relocatedRoot, 'Contents/Resources/agent-runtime/runtime.json')), readFileSync(join(f.payload, 'runtime.json')));
  writeFileSync(join(f.state, 'agent/agent.json'), JSON.stringify({ ...registration, appPath: newApp }));
  assert.equal((await call(old)).result.structuredContent.error.code, 'APP_UNAVAILABLE'); assert.equal(operations, 1);
  const next = open(t, { ...f, app: newApp }, ['--mcp'], {}); await next.ask('tools/list');
  assert.equal((await call(next)).result.structuredContent.error.code, 'MALFORMED'); assert.equal(operations, 2);
  old.child.kill('SIGTERM'); await old.exited; assert.equal(old.child.signalCode, 'SIGTERM');
  assert.throws(() => process.kill(old.child.pid!, 0));
  next.child.stdin.end(); await next.exited; assert.equal(next.child.exitCode, 0);
  for (const client of [old, next]) { clean(client); for (const secret of [f.app, newApp, f.state, 'private-fixture-token', 'private shell noise']) assert.ok(!client.stdout().includes(secret)); }
  assert.equal(existsSync(join(f.home, 'Library/LaunchAgents')), false);
});


test('native installed entry serves MCP against its actual bundled foreground agent and client EOF preserves that agent', { skip, timeout: 25_000 }, async t => {
  const f = fixture(t), repo = join(f.home, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true }); mkdirSync(join(f.state, 'agent'), { recursive: true });
  writeFileSync(join(f.state, 'state.json'), JSON.stringify({ repo }));
  const metadata = JSON.parse(readFileSync(join(f.payload, 'runtime.json'), 'utf8'));
  writeFileSync(join(f.state, 'agent/agent.json'), JSON.stringify({ version: 1, installedBy: 'app', agentVersion: metadata.agentVersion, appPath: f.app, policy: 'manual', policySource: 'person', paused: null }));
  const agent = spawn(join(f.payload, 'bun'), [join(f.payload, 'agent.mjs')], {
    cwd: '/', env: { HOME: f.home, PATH: '', SHELL: f.shell, NORTUSCC_DESKTOP_LOCAL_ONLY: '1', NORTUSCC_STATE_DIR: f.state }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let agentStdout = '', agentStderr = ''; agent.stdout.on('data', chunk => { agentStdout += chunk; }); agent.stderr.on('data', chunk => { agentStderr += chunk; });
  const exited = new Promise<void>((done, reject) => { agent.once('error', reject); agent.once('close', () => done()); });
  f.cleanups.push(async () => { if (agent.exitCode === null && agent.signalCode === null) agent.kill('SIGKILL'); await exited; });
  const deadline = Date.now() + 8000;
  let connection: Awaited<ReturnType<typeof connectAgent>> | undefined;
  while (!connection && Date.now() < deadline && agent.exitCode === null) {
    try { connection = await connectAgent({ stateRoot: f.state }, { client: 'app', timeoutMs: 100 }); }
    catch { await new Promise(done => setTimeout(done, 10)); }
  }
  assert.ok(connection, agentStderr); connection.close();
  const context = async (client: ReturnType<typeof open>) => {
    await client.ask('tools/list');
    const reply = await client.ask('tools/call', { name: 'nortuscc_get_context', arguments: {} });
    assert.notEqual(reply.result.isError, true, JSON.stringify(reply)); assert.equal(reply.result.structuredContent.app.ownership, 'app');
    assert.equal(reply.result.structuredContent.capabilities.addSkill.available, true);
  };
  const first = open(t, f); await context(first); first.child.stdin.end(); await first.exited;
  assert.equal(first.child.exitCode, 0); assert.equal(agent.exitCode, null); process.kill(agent.pid!, 0);
  const next = open(t, f); await context(next); next.child.stdin.end(); await next.exited; assert.equal(next.child.exitCode, 0);
  for (const client of [first, next]) clean(client);
  assert.equal(agentStdout, ''); assert.equal(existsSync(join(f.home, 'Library/LaunchAgents')), false);
  agent.kill('SIGTERM'); await exited; assert.equal(agent.exitCode, 0, agentStderr);
});
