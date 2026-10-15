import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { before, after, test } from 'node:test';
import { build } from 'esbuild';
import { Deferred, Effect, Exit, Scope } from 'effect';
import { AgentStateStore, makeSession, serveIpc, startAgent, type AgentDomain } from '@nortuscc/agent';
import { configDomain, DecisionsStore, integrationsDomain, Processes } from '@nortuscc/machine';
import { decodeOperationOutput, operationJsonSchemas, type OperationName } from '@nortuscc/agent/operations';
import { agentMachine } from '../../../packages/agent/checks/support/agent-machine.ts';
import { accept, EFFORT, setupFixture } from '../../../packages/agent/checks/support/setup-fixture.ts';

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-bundle-')));
const bundle = join(fixtureRoot, 'Test.app/Contents/Resources/agent-runtime');
const expectedApp = join(fixtureRoot, 'Test.app/Contents/MacOS/Test');
const nativeRuntime = process.env.DESKTOP_MCP_NATIVE_RUNTIME;
const packagedResources = process.env.DESKTOP_AGENT_RESOURCES;
const expectedRuntime = nativeRuntime && packagedResources ? JSON.parse(readFileSync(join(packagedResources, 'runtime.json'), 'utf8')).agentVersion : '9.9.9';
const shell = join(fixtureRoot, 'shell');
before(async () => {
  mkdirSync(bundle, { recursive: true }); mkdirSync(dirname(expectedApp), { recursive: true });
  writeFileSync(shell, '#!/bin/sh\nexec /bin/sh -c "$2"\n'); chmodSync(shell, 0o755);
  if (nativeRuntime && packagedResources) {
    cpSync(packagedResources, bundle, { recursive: true }); copyFileSync(nativeRuntime, expectedApp); chmodSync(expectedApp, 0o755);
  } else {
    await build({ entryPoints: [fileURLToPath(new URL('../mcp/main.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', target: 'esnext', outfile: join(bundle, 'mcp.mjs') });
    writeFileSync(join(bundle, 'runtime.json'), JSON.stringify({ target: 'darwin-arm64', appVersion: '0.1.6', agentVersion: expectedRuntime, mcp: { protocol: 1, executable: 'mcp.mjs' } }));
  }
});
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
const names: Record<OperationName, string> = { resolveSkillCandidate: 'nortuscc_resolve_skill_candidate', getContext: 'nortuscc_get_context', inspect: 'nortuscc_inspect', previewChange: 'nortuscc_preview_change', applyChange: 'nortuscc_apply_change', getRun: 'nortuscc_get_run', listRuns: 'nortuscc_list_runs', cancelRun: 'nortuscc_cancel_run', history: 'nortuscc_history' };

// Real newline-delimited MCP over the packaged entry, with every stdout record captured.
function open(runtime: string, stateRoot: string, modern = false) {
  const child = spawn(runtime, runtime === expectedApp ? ['--mcp'] : [join(bundle, 'mcp.mjs'), '--app', expectedApp], { cwd: '/', env: { HOME: fixtureRoot, SHELL: shell, NORTUSCC_STATE_DIR: stateRoot, PATH: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const records: any[] = [];
  let buffer = '', stderr = '', id = 0, terminated = false;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const record = JSON.parse(line); records.push(record);
        const p = pending.get(record.id); if (p) { clearTimeout(p.timer); pending.delete(record.id); p.resolve(record); }
      } catch { for (const p of pending.values()) p.reject(new Error(`non-MCP stdout: ${line}`)); }
    }
  });
  const exited = new Promise<void>(done => child.once('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MCP exited: ${stderr}`)); } done(); }));
  const ask = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP timeout: ${stderr}`)); }, 10_000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params: { ...params, ...(modern ? { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } : {}) } }) + '\n');
  });
  return { records, diagnostics: () => stderr, ask, call: (operation: OperationName, args: object = {}) => ask('tools/call', { name: names[operation], arguments: args }),
    initialize: async () => {
      if (modern) return ask('tools/list');
      const result = await ask('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
      assert.equal(result.result.protocolVersion, '2025-11-25');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return ask('tools/list');
    }, terminate: async () => { terminated = true; child.kill('SIGKILL'); await exited; assert.equal(child.signalCode, 'SIGKILL'); assert.throws(() => process.kill(child.pid!, 0)); }, close: async () => {
      child.stdin.end(); const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
      await exited; clearTimeout(kill);
      if (terminated) assert.equal(child.signalCode, 'SIGKILL'); else assert.equal(child.exitCode, 0, stderr);
      assert.equal(buffer, '');
      for (const record of records) assert.equal(record.jsonrpc, '2.0');
    } };
}

function output(operation: OperationName, reply: any) {
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.notEqual(reply.result.isError, true, JSON.stringify(reply));
  assert.deepEqual(JSON.parse(reply.result.content[0].text), reply.result.structuredContent);
  return decodeOperationOutput(operation, reply.result.structuredContent) as any;
}
async function agent(identity: 'app' | 'cli' = 'app', inputs: { nativeOutput?: string; profileJson?: string; pinsJson?: string; skillCandidates?: Parameters<typeof makeSession>[1]['skillCandidates'] } = {}) {
  const m = agentMachine('/tmp');
  const { nativeOutput, profileJson, pinsJson } = inputs;
  const fixture = setupFixture(join(m.root, 'setup'), { headFiles: {
    ...(nativeOutput === undefined ? {} : { 'integrations.json': JSON.stringify({ version: 1, integrations: [
      { id: 'fixture-mcp', label: 'fixture MCP', target: 'codex', type: 'mcp', default: true, command: 'fixture-server' },
    ] }) }),
    ...(profileJson === undefined ? {} : { 'claude/settings.keys.json': profileJson }),
    ...(pinsJson === undefined ? {} : { 'skill-pins.json': pinsJson }),
  } });
  m.write(join(m.paths.claude, 'settings.json'), '{"theme":"dark"}\n');
  await m.trust();
  await m.run(DecisionsStore.use(s => s.record(accept(EFFORT))));
  await m.run(AgentStateStore.use(s => s.update(state => ({ ...state, installedBy: identity, agentVersion: expectedRuntime, appPath: expectedApp }))));
  m.write(join(m.root, 'runtime.json'), JSON.stringify({ target: 'darwin-arm64', agentVersion: expectedRuntime, appVersion: '0.1.6' }));
  const started = Deferred.makeUnsafe<void>(), release = Deferred.makeUnsafe<void>();
  const config: AgentDomain = { ...configDomain, run: (step, report) => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Deferred.await(release); return yield* configDomain.run(step, report); }) };
  const domains = (paths: typeof m.paths) => {
    const integrations = integrationsDomain({ paths, env: {} });
    return [config, nativeOutput === undefined ? integrations : {
      ...integrations,
      inspect: (desired: Parameters<typeof integrations.inspect>[0]) => integrations.inspect(desired).pipe(
        Effect.provideService(Processes, { run: () => Effect.succeed({ code: 0, stdout: nativeOutput, stderr: 'FAKE_STDERR' }) }),
      ),
    }];
  };
  const scope = Scope.makeUnsafe();
  await m.run(Effect.gen(function* () {
    const handle = yield* startAgent(domains);
    const session = yield* makeSession(handle, { signal: new AbortController().signal, domains, skillCandidates: inputs.skillCandidates });
    yield* serveIpc({ paths: m.paths, handle, session, agentVersion: expectedRuntime, appRuntime: { version: '0.1.6', runtimeId: expectedRuntime, appDirectory: dirname(expectedApp), platform: 'darwin', target: 'darwin-arm64', metadataPath: join(m.root, 'runtime.json') }, onShutdown: () => {} });
    while ((yield* handle.status) === undefined) yield* Effect.sleep('10 millis');
  }).pipe(Scope.provide(scope)), fixture.source);
  return { m, started, release, close: async () => { Deferred.doneUnsafe(release, Effect.void); await Effect.runPromise(Scope.close(scope, Exit.void)); rmSync(m.root, { recursive: true, force: true }); } };
}

const runtimes = [...(nativeRuntime && packagedResources ? [expectedApp] : []), process.execPath, process.env.DESKTOP_MCP_BUN_RUNTIME ?? execFileSync('bun', ['-e', 'console.log(process.execPath)'], { encoding: 'utf8' }).trim()];
for (const runtime of runtimes) for (const modern of [false, true]) {
  test(`${runtime}: ${modern ? 'modern 2026' : 'legacy 2025'} opening, shared tools and reconnectable agent runs`, { timeout: 30_000 }, async t => {
    const s = await agent(); t.after(s.close);
    const client = open(runtime, s.m.paths.stateRoot, modern); t.after(client.close);
    const listed = await client.initialize();
    assert.equal(listed.error, undefined, JSON.stringify(listed));
    assert.deepEqual(listed.result.tools.map((tool: any) => tool.name).sort(), Object.values(names).sort());
    for (const [operation, name] of Object.entries(names)) {
      const tool = listed.result.tools.find((tool: any) => tool.name === name);
      assert.deepEqual(tool.inputSchema, operationJsonSchemas[operation as OperationName].input);
      assert.deepEqual(tool.outputSchema, { type: 'object', ...operationJsonSchemas[operation as OperationName].output });
    }
    assert.equal(output('getContext', await client.call('getContext')).app.ownership, 'app');
    output('inspect', await client.call('inspect'));
    const invalid = await client.call('previewChange', { change: { kind: 'reconcile', only: [], force: true } });
    assert.equal(invalid.result.isError, true); assert.ok(invalid.result.content[0].text.length < 600);
    const refused = await client.call('inspect', { scope: { kind: 'user' } });
    assert.equal(refused.result.isError, true); assert.equal(refused.result.structuredContent.error.code, 'UNSUPPORTED_SCOPE');
    const preview = output('previewChange', await client.call('previewChange', { change: { kind: 'reconcile', only: ['config:claude:settings.json#effortLevel'] } }));
    const applied = output('applyChange', await client.call('applyChange', { planId: preview.planId, requestId: 'caller-owned-intent' }));
    assert.equal(applied.status, 'started');
    await Effect.runPromise(Deferred.await(s.started));
    assert.equal(output('getRun', await client.call('getRun', { runId: applied.run.runId })).result, null);
    if (runtime === expectedApp && modern) await client.terminate(); else await client.close();
    const next = open(runtime, s.m.paths.stateRoot, modern); t.after(next.close); await next.initialize();
    assert.equal(output('getRun', await next.call('getRun', { runId: applied.run.runId })).intent.requestId, 'caller-owned-intent');
    assert.equal(output('applyChange', await next.call('applyChange', { planId: preview.planId, requestId: 'caller-owned-intent' })).run.runId, applied.run.runId);
    assert.equal(output('listRuns', await next.call('listRuns', { limit: 10 })).runs.length, 1);
    Deferred.doneUnsafe(s.release, Effect.void);
    let run = output('getRun', await next.call('getRun', { runId: applied.run.runId }));
    while (run.result === null) run = output('getRun', await next.call('getRun', { runId: applied.run.runId }));
    assert.equal(output('cancelRun', await next.call('cancelRun', { runId: applied.run.runId })).state, 'succeeded');
    const history = output('history', await next.call('history', { limit: 100 }));
    assert.ok(history.events.some((event: any) => event.actor === 'mcp' && event.requestId === 'caller-owned-intent'));
  });
}

for (const runtime of [process.execPath, ...(nativeRuntime && packagedResources ? [expectedApp] : [])]) test(`${runtime}: CLI-owned agent exposes context diagnostics but cannot execute shared operations`, async t => {
  const s = await agent('cli'); t.after(s.close);
  const client = open(runtime, s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  assert.ok(output('getContext', await client.call('getContext')).diagnostics.length > 0);
  const refused = await client.call('inspect'); assert.equal(refused.result.structuredContent.error.code, 'APP_UNAVAILABLE');
});

test('malformed replies and private failure codes are redacted and an identical-runtime app relocation refuses the old MCP process', async t => {
  const root = mkdtempSync('/tmp/mcp-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const { mkdirSync } = await import('node:fs'); mkdirSync(join(root, 'agent'));
  writeFileSync(join(root, 'agent/agent.token'), 'fixture-secret-token');
  const registration = { version: 1, installedBy: 'app', agentVersion: expectedRuntime, appPath: expectedApp };
  writeFileSync(join(root, 'agent/agent.json'), JSON.stringify(registration));
  let operations = 0;
  let privateFailure = false;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = ''; socket.on('data', chunk => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (request.command === 'hello') { assert.equal(request.client, 'mcp'); assert.equal(request.runtimeId, expectedRuntime); assert.equal(request.token, 'fixture-secret-token'); }
        if (request.command === 'operation') operations++;
        const result = request.command === 'hello' ? { agentVersion: expectedRuntime, protocol: 3, policy: 'manual', paused: null, operationsProtocol: 1, app: { ownership: 'app', version: '0.1.6', runtimeId: expectedRuntime }, operations: { available: true } } : { rawSecret: 'fixture-private-path-token' };
        const reply = request.command === 'operation' && privateFailure
          ? { version: 3, id: request.id, ok: false, error: { code: 'PRIVATE_SECRET_VALUE', message: 'fixture-private-failure-message' } }
          : { version: 3, id: request.id, ok: true, result };
        socket.write(JSON.stringify(reply) + '\n');
      }
    });
  });
  await new Promise<void>(done => server.listen(join(root, 'agent/agent.sock'), done));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())); });
  const client = open(process.execPath, root); t.after(client.close); await client.initialize();
  const reply = await client.call('getRun', { runId: 'r' });
  assert.equal(reply.result.isError, true); assert.equal(reply.result.structuredContent.error.code, 'MALFORMED');
  assert.ok(!JSON.stringify(client.records).includes('fixture-private-path-token'));
  assert.ok(!JSON.stringify(client.records).includes('fixture-secret-token'));
  privateFailure = true;
  const failure = await client.call('getRun', { runId: 'r' });
  assert.equal(failure.result.isError, true);
  assert.equal(failure.result.structuredContent.error.code, 'OPERATION_FAILED');
  assert.deepEqual(JSON.parse(failure.result.content[0].text), failure.result.structuredContent);
  for (const secret of ['PRIVATE_SECRET_VALUE', 'fixture-private-failure-message']) {
    assert.ok(!JSON.stringify(client.records).includes(secret));
    assert.ok(!client.diagnostics().includes(secret));
  }
  writeFileSync(join(root, 'agent/agent.json'), JSON.stringify({ ...registration, appPath: '/tmp/Relocated.app/Contents/MacOS/Test' }));
  const relocated = await client.call('getContext');
  assert.equal(relocated.result.structuredContent.error.code, 'APP_UNAVAILABLE');
  assert.equal(operations, 2, 'the old MCP process must not reach an identical-version relocated agent');
  assert.ok(!JSON.stringify(client.records).includes(expectedApp));
  assert.ok(!JSON.stringify(client.records).includes('Relocated.app'));
});

for (const runtime of runtimes) test(`${runtime}: successful MCP inspect redacts malformed native listing diagnostics`, async t => {
  const sentinel = 'FAKE_TOKEN';
  const s = await agent('app', { nativeOutput: sentinel }); t.after(s.close);
  const client = open(runtime, s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  const inspected = output('inspect', await client.call('inspect'));
  assert.ok(inspected.probeErrors.some((note: string) => note.includes('could not read the Codex MCP server list')));
  for (const secret of [sentinel, 'FAKE_STDERR']) {
    assert.ok(!JSON.stringify(client.records).includes(secret));
    assert.ok(!client.diagnostics().includes(secret));
  }
});

for (const runtime of runtimes) test(`${runtime}: successful MCP inspect redacts malformed profile parser diagnostics`, async t => {
  const sentinel = 'FAKE_TOKEN';
  const s = await agent('app', { profileJson: sentinel }); t.after(s.close);
  const client = open(runtime, s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  const inspected = output('inspect', await client.call('inspect'));
  assert.ok(inspected.profile.issues.some((issue: { message: string }) => issue.message.includes('not valid JSON')));
  assert.ok(!JSON.stringify(client.records).includes(sentinel));
  assert.ok(!client.diagnostics().includes(sentinel));
});

for (const runtime of runtimes) test(`${runtime}: successful MCP inspect omits rejected profile schema keys`, async t => {
  const sentinel = 'FAKE_TOKEN';
  const s = await agent('app', { pinsJson: JSON.stringify({ version: 1, pins: {}, [sentinel]: 'private' }) }); t.after(s.close);
  const client = open(runtime, s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  const inspected = output('inspect', await client.call('inspect'));
  assert.ok(inspected.profile.issues.some((issue: { source: string }) => issue.source === 'skill-pins.json'));
  assert.ok(!JSON.stringify(client.records).includes(sentinel));
  assert.ok(!client.diagnostics().includes(sentinel));
});


test('MCP exposes bounded discovery and source-specific preview; a stale mutation refuses without intent writes', { timeout: 10_000 }, async t => {
  const source = 'owner/repo', revision = 'a'.repeat(40);
  const s = await agent('app', { skillCandidates: () => Effect.succeed({ ok: true, source, revision, candidates: [{ source, revision, installedName: 'design-review', selectorName: 'Design Review', sourceDir: 'skills/layout', description: 'Review design', tree: 'b'.repeat(40), blob: 'c'.repeat(40), internal: false, metadata: {} }] }) }); t.after(s.close);
  const client = open(process.execPath, s.m.paths.stateRoot); t.after(client.close);
  const listed = await client.initialize();
  for (const operation of ['resolveSkillCandidate', 'previewChange'] as const) {
    const tool = listed.result.tools.find((tool: any) => tool.name === names[operation]); assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.openWorldHint, true);
  }
  output('inspect', await client.call('inspect'));
  const found = output('resolveSkillCandidate', await client.call('resolveSkillCandidate', { source, name: 'DESIGN REVIEW' })); assert.equal(found.status, 'found');
  await client.close();
  const next = open(process.execPath, s.m.paths.stateRoot); t.after(next.close); await next.initialize();
  const beforeHistory = output('history', await next.call('history', { limit: 10 }));
  const preview = output('previewChange', await next.call('previewChange', { change: { kind: 'addSkill', candidateId: found.candidates[0].candidateId, targets: ['claude'] } }));
  assert.equal(preview.skillAddition.declaration.after.name, 'design-review'); assert.equal(preview.skillAddition.sharedStore.codexScans, true); assert.deepEqual(preview.nextActions, []);
  // Change composed intent after review. The durable driver must refuse before any installer.
  s.m.write(join(s.m.paths.stateRoot, 'overrides.json'), JSON.stringify({ version: 2, skills: { changed: false } }));
  const refused = await next.call('applyChange', { planId: preview.planId, requestId: 'stale-addition' }); assert.equal(refused.result.isError, true); assert.equal(refused.result.structuredContent.error.code, 'UNKNOWN_PLAN');
  assert.deepEqual(JSON.parse(s.m.read(join(s.m.paths.stateRoot, 'overrides.json'))!), { version: 2, skills: { changed: false } }); assert.deepEqual(output('listRuns', await next.call('listRuns', { limit: 10 })).runs, []);
  assert.equal(existsSync(s.m.paths.backups), false); assert.deepEqual(output('history', await next.call('history', { limit: 10 })), beforeHistory);
});
