import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect, Layer } from 'effect';
import { agentLayer, DEFAULT_STATE, renderLaunchAgent, unitPath } from '@nortuscc/agent';
import { backupsForRun, FileIntegrity, FsFailed, nodeFileIntegrity, Processes, liveLockHolder, type MachinePathsValue } from '@nortuscc/machine';
import { AgentUnavailable, type AgentConnection } from '../../../src/agent-client.ts';
import { resourceProgram, ensureAgent } from '../agent/lifecycle.ts';
import * as maintenance from '../agent/maintenance.ts';
import { decodePrepareUpdate, decodeMaintenanceAction, decodeRecoverUpdate } from '../shared/maintenance-protocol.ts';

const fixture = (t: { after: (f: () => void) => void }, integrityOverrides?: Partial<FileIntegrity['Service']>) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'update-maintenance-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateRoot = join(home, 'state');
  const paths: MachinePathsValue = { repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'), codexOpenRouter: join(home, '.glm'), agentsSkills: join(home, '.agents'), stateRoot, backups: join(stateRoot, 'backups') };
  const bundle = join(home, 'Nortuscc.app');
  const resources = join(bundle, 'Contents/Resources/resources/darwin-arm64');
  const appPath = join(bundle, 'Contents/MacOS/Nortuscc');
  mkdirSync(resources, { recursive: true }); mkdirSync(join(bundle, 'Contents/MacOS')); mkdirSync(join(stateRoot, 'agent'), { recursive: true }); mkdirSync(join(paths.repo, '.git'), { recursive: true });
  writeFileSync(appPath, 'old executable'); writeFileSync(join(resources, 'agent.mjs'), 'old agent'); writeFileSync(join(resources, 'bun'), 'fake bun');
  const agentVersion = createHash('sha256').update('old agent').digest('hex');
  writeFileSync(join(resources, 'runtime.json'), JSON.stringify({ maintenanceProtocol: 1, appVersion: '1.0.0', target: 'darwin-arm64', bun: '1.3.0', executable: 'bun', agentVersion }));
  writeFileSync(join(bundle, 'Contents/Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>1.0.0</string></dict></plist>');
  const target = { platform: 'darwin' as const, home, uid: 501, user: 'fake', stateRoot };
  const input = { paths, resources, appPath, agentVersion, target, env: { HOME: home, PATH: '/fake' } };
  writeFileSync(join(stateRoot, 'agent/agent.json'), JSON.stringify({ ...DEFAULT_STATE, policy: 'manual', policySource: 'person', paused: { reason: 'keep', at: 'original' }, installedBy: 'app', appPath, agentVersion, future: 42 }));
  writeFileSync(join(stateRoot, 'agent/setups.json'), '{"version":1,"setups":[],"future":"keep"}');
  mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
  writeFileSync(unitPath(target), renderLaunchAgent('com.nortuscc.agent', resourceProgram(input)));
  writeFileSync(join(stateRoot, 'agent/app-service.json'), JSON.stringify({ agentVersion, appPath, program: resourceProgram(input) }));
  const events: string[] = []; let applying = false; let stopFails = false; let respawn = false;
  const processes = Layer.succeed(Processes, { run: command => Effect.sync(() => {
    assert.equal(command.cmd, 'launchctl'); events.push(command.args[0]!);
    if (respawn && command.args[0] === 'bootout') {
      writeFileSync(join(stateRoot, 'agent/agent.lock'), JSON.stringify({ pid: process.pid }));
      setTimeout(() => rmSync(join(stateRoot, 'agent/agent.lock'), { force: true }), 15);
    }
    return { code: stopFails ? 5 : 0, stdout: '', stderr: 'fake stop failed' };
  }) });
  const connect = async (): Promise<AgentConnection> => ({ hello: { protocol: 3, agentVersion, policy: 'manual', paused: null },
    request: async <A>(request: object): Promise<A> => { const command = (request as { command: string }).command; events.push(command); return (command === 'status' ? { at: '2026-10-11T00:00:00Z', policy: 'manual', paused: null, trusted: true, pending: [], drift: [], conflicts: [], probeErrors: [], counts: { pending: 0, held: 0, ready: 0, drift: 0 }, applying } : { shutdown: true }) as A; },
    close: () => { events.push('close'); }, onEvent: () => () => {}, onClose: () => () => {} });
  const integrity = integrityOverrides === undefined ? nodeFileIntegrity
    : Layer.effect(FileIntegrity, FileIntegrity.use(service => Effect.succeed({ ...service, ...integrityOverrides }))).pipe(Layer.provide(nodeFileIntegrity));
  const layer = backupsForRun().pipe(Layer.provideMerge(Layer.merge(agentLayer(paths, { processes }), integrity)));
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>, signal?: AbortSignal) => Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>, { signal });
  const journalPath = join(stateRoot, 'agent/pending-update.json');
  return { input, paths, resources, appPath, bundle, agentVersion, events, connect, run, journalPath,
    applying: () => { applying = true; }, failStop: () => { stopFails = true; }, respawn: () => { respawn = true; } };
};
const records = (...values: unknown[]): AsyncIterable<string> => ({ async *[Symbol.asyncIterator]() { for (const value of values) yield JSON.stringify(value) + '\n'; } });

test('maintenance records reject extra fields, unstable versions and invalid transitions', () => {
  assert.deepEqual(decodePrepareUpdate({ fromVersion: '1.0.0', toVersion: '1.1.0' }), { fromVersion: '1.0.0', toVersion: '1.1.0' });
  for (const value of [{ fromVersion: '1.0.0', toVersion: '1.0.0' }, { fromVersion: '1.0.0', toVersion: '2.0.0-beta' }, { fromVersion: '1.0.0', toVersion: '2.0.0', path: '/bad' }]) assert.throws(() => decodePrepareUpdate(value));
  assert.deepEqual(decodeMaintenanceAction({ action: 'begin-install', installerPid: 777777 }), { action: 'begin-install', installerPid: 777777 });
  assert.throws(() => decodeMaintenanceAction({ action: 'commit', extra: true }));
  assert.throws(() => decodeRecoverUpdate({ appVersion: '1.0.0', path: '/bad' }));
});

test('prepare holds both fences through durable installing acknowledgement and commit preserves state bytes', async t => {
  const f = fixture(t); const output: unknown[] = [];
  const before = readFileSync(join(f.paths.stateRoot, 'agent/agent.json'), 'utf8');
  const result = await f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }, { action: 'begin-install', installerPid: 777777 }, { action: 'commit' }), stdout: value => {
    output.push(value); assert.equal(liveLockHolder(join(f.paths.stateRoot, 'agent/app-install.lock')), process.pid); assert.equal(liveLockHolder(join(f.paths.stateRoot, 'apply.lock')), process.pid);
    if ((value as { installing?: boolean }).installing) assert.equal(JSON.parse(readFileSync(f.journalPath, 'utf8')).phase, 'installing');
  }, connect: f.connect, pollMs: 1, timeoutMs: 100 }));
  assert.deepEqual(result, { committed: true }); assert.equal(output.length, 2);
  assert.equal(JSON.parse(readFileSync(f.journalPath, 'utf8')).phase, 'awaiting-health');
  assert.equal(readFileSync(join(f.paths.stateRoot, 'agent/agent.json'), 'utf8'), before);
  assert.equal(liveLockHolder(join(f.paths.stateRoot, 'apply.lock')), undefined);
  await assert.rejects(f.run(ensureAgent(f.input, { connect: f.connect })), /pending|recovery/);
});

test('EOF after begin-install never restarts an old service or removes pending', async t => {
  const f = fixture(t);
  await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }, { action: 'begin-install', installerPid: 777777 }), stdout: () => {}, connect: f.connect, timeoutMs: 100, pollMs: 1 })), /interrupted|EOF/);
  assert.equal(JSON.parse(readFileSync(f.journalPath, 'utf8')).phase, 'installing');
  assert.ok(!f.events.includes('bootstrap')); assert.equal(liveLockHolder(join(f.paths.stateRoot, 'apply.lock')), undefined);
});

test('busy agent times out without shutdown or journal', async t => {
  const f = fixture(t); f.applying();
  await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }), stdout: () => {}, connect: f.connect, timeoutMs: 25, pollMs: 1 })), /idle|applying|timed out/);
  assert.ok(!f.events.includes('shutdown')); assert.ok(!existsSync(f.journalPath));
});

test('registration preserves unknown pause fields rather than normalizing stored authority', async t => {
  const f = fixture(t); const path = join(f.paths.stateRoot, 'agent/agent.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')); raw.paused.future = { exact: true }; writeFileSync(path, JSON.stringify(raw));
  await f.run(ensureAgent(f.input, { restart: true, connect: f.connect, retryDelayMs: 0 }));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).paused, raw.paused);
});

test('existing corrupt agent authority is refused before shutdown and byte-preserved', async t => {
  const f = fixture(t); const path = join(f.paths.stateRoot, 'agent/agent.json'); const text = '{"version":1,"policy":"bogus","policySource":"person","paused":null}'; writeFileSync(path, text);
  await assert.rejects(f.run(ensureAgent(f.input, { restart: true, connect: f.connect })), /invalid/);
  assert.equal(readFileSync(path, 'utf8'), text); assert.deepEqual(f.events, []);
});

test('target recovery rejects mismatched runtime health and retains the journal', async t => {
  const f = fixture(t);
  await f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }, { action: 'begin-install', installerPid: 777777 }, { action: 'commit' }), stdout: () => {}, connect: f.connect, retryDelayMs: 0 }));
  writeFileSync(join(f.bundle, 'Contents/Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>1.1.0</string></dict></plist>');
  const runtimePath = join(f.resources, 'runtime.json'); const runtime = JSON.parse(readFileSync(runtimePath, 'utf8')); runtime.appVersion = '1.1.0'; writeFileSync(runtimePath, JSON.stringify(runtime));
  const incompatible = async (): Promise<AgentConnection> => ({ ...await f.connect(), hello: { protocol: 3, agentVersion: 'wrong', policy: 'manual', paused: null } });
  await assert.rejects(f.run(maintenance.recoverUpdate(f.input, { stdin: records({ appVersion: '1.1.0' }), connect: incompatible, timeoutMs: 100, pollMs: 1, retryDelayMs: 0 })), /health identity/);
  assert.ok(existsSync(f.journalPath));
  assert.deepEqual(await f.run(maintenance.recoverUpdate(f.input, { stdin: records({ appVersion: '1.1.0' }), connect: f.connect, timeoutMs: 100, pollMs: 1, retryDelayMs: 0 })), { recovered: true, interrupted: false, stateRoot: f.paths.stateRoot });
  assert.ok(!existsSync(f.journalPath));
});

test('prepared EOF restores only a proven intact old service', async t => {
  const f = fixture(t);
  await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }), stdout: () => {}, connect: f.connect, retryDelayMs: 0 })), /interrupted|EOF/);
  assert.ok(f.events.includes('bootstrap')); assert.ok(!existsSync(f.journalPath));
});

test('cancellation after installing joins finalizers, keeps pending and releases both fences', async t => {
  const f = fixture(t); const controller = new AbortController();
  const stdin = { async *[Symbol.asyncIterator]() { yield JSON.stringify({ fromVersion: '1.0.0', toVersion: '1.1.0' }) + '\n'; yield JSON.stringify({ action: 'begin-install', installerPid: 777777 }) + '\n'; await new Promise(() => {}); } };
  await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin, stdout: value => { if ((value as { installing?: boolean }).installing) controller.abort(); }, connect: f.connect, timeoutMs: 100, pollMs: 1 }), controller.signal));
  assert.equal(JSON.parse(readFileSync(f.journalPath, 'utf8')).phase, 'installing');
  assert.equal(liveLockHolder(join(f.paths.stateRoot, 'agent/app-install.lock')), undefined); assert.equal(liveLockHolder(join(f.paths.stateRoot, 'apply.lock')), undefined);
  assert.ok(!f.events.includes('bootstrap'));
});

test('unload failure does not grant permission for native installation', async t => {
  const f = fixture(t); f.failStop(); const output: unknown[] = [];
  await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }), stdout: value => output.push(value), connect: f.connect })), /unload/);
  assert.deepEqual(output, []); assert.ok(existsSync(f.journalPath));
});

test('a valid auto-apply policy remains unchanged across registration', async t => {
  const f = fixture(t); const path = join(f.paths.stateRoot, 'agent/agent.json'); const raw = JSON.parse(readFileSync(path, 'utf8')); raw.policy = 'auto-apply'; writeFileSync(path, JSON.stringify(raw));
  await f.run(ensureAgent(f.input, { restart: true, connect: f.connect, retryDelayMs: 0 }));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).policy, 'auto-apply');
});

test('recovery rejects trailing records before changing service registration', async t => {
  const f = fixture(t);
  await assert.rejects(f.run(maintenance.recoverUpdate(f.input, { stdin: records({ appVersion: '1.0.0' }, { action: 'commit' }), connect: f.connect })), /one record|extra/);
  assert.deepEqual(f.events, []);
});

test('unknown maintenance protocol refuses preparation before service shutdown', async t => {
  const f = fixture(t); const path = join(f.resources, 'runtime.json'); const raw = JSON.parse(readFileSync(path, 'utf8')); raw.maintenanceProtocol = 2; writeFileSync(path, JSON.stringify(raw));
  await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }), stdout: () => {}, connect: f.connect })), /compatibility|protocol/);
  assert.deepEqual(f.events, []);
});

test('native compiled version refuses recovery against a different installed app', async t => {
  const f = fixture(t);
  f.failStop(); await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }), stdout: () => {}, connect: f.connect })), /unload/);
  f.events.length = 0;
  await assert.rejects(f.run(maintenance.recoverUpdate(f.input, { stdin: records({ appVersion: '1.1.0' }), connect: f.connect })), /native app version/);
  assert.deepEqual(f.events, []); assert.ok(existsSync(f.journalPath));
});

test('maintenance waits out an apply lock acquired during the status check', async t => {
  const f = fixture(t); let checks = 0;
  const connect = async (): Promise<AgentConnection> => {
    const conn = await f.connect(), request = conn.request;
    return { ...conn, request: async <A>(command: object, options?: { timeoutMs?: number }) => {
      const name = (command as { command: string }).command;
      if (name === 'status' && ++checks === 1) {
        writeFileSync(join(f.paths.stateRoot, 'apply.lock'), JSON.stringify({ pid: process.pid }));
        setTimeout(() => rmSync(join(f.paths.stateRoot, 'apply.lock'), { force: true }), 10);
      }
      if (name === 'shutdown') assert.ok(checks > 1);
      return request<A>(command, options);
    } };
  };
  assert.deepEqual(await f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }, { action: 'abort' }), stdout: () => {}, connect, timeoutMs: 100, pollMs: 1, retryDelayMs: 0 })), { aborted: true });
  assert.ok(!existsSync(f.journalPath));
});

test('maintenance state refuses a corrupt journal with bounded diagnostics', async t => {
  const f = fixture(t); writeFileSync(f.journalPath, '{bad');
  assert.deepEqual(await f.run(maintenance.maintenanceState(f.input)), { pending: true, phase: null, fromVersion: null, toVersion: null, backupPath: null, diagnostic: 'Pending update journal is invalid; manual recovery is required.' });
});

test('runtime app version cannot differ from the installed bundle', async t => {
  const f = fixture(t); const path = join(f.resources, 'runtime.json'); const raw = JSON.parse(readFileSync(path, 'utf8')); raw.appVersion = '9.0.0'; writeFileSync(path, JSON.stringify(raw));
  await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }), stdout: () => {}, connect: f.connect })), /runtime.*version/);
  assert.deepEqual(f.events, []);
});

test('recovery cancellation joins its health connection before releasing locks and never clears pending later', async t => {
  const f = fixture(t);
  await f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }, { action: 'begin-install', installerPid: 777777 }, { action: 'commit' }), stdout: () => {}, connect: f.connect, retryDelayMs: 0 }));
  writeFileSync(join(f.bundle, 'Contents/Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>1.1.0</string></dict></plist>');
  const path = join(f.resources, 'runtime.json'); const raw = JSON.parse(readFileSync(path, 'utf8')); raw.appVersion = '1.1.0'; writeFileSync(path, JSON.stringify(raw));
  const controller = new AbortController(); let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }); let calls = 0;
  const connect = async (): Promise<AgentConnection> => {
    if (++calls === 2) { entered(); await new Promise(resolve => setTimeout(resolve, 40)); }
    return f.connect();
  };
  const running = f.run(maintenance.recoverUpdate(f.input, { stdin: records({ appVersion: '1.1.0' }), connect, timeoutMs: 200, pollMs: 1, retryDelayMs: 0 }), controller.signal);
  const rejected = assert.rejects(running);
  await ready; controller.abort(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(liveLockHolder(join(f.paths.stateRoot, 'agent/app-install.lock')), process.pid);
  await rejected; assert.ok(existsSync(f.journalPath)); assert.equal(liveLockHolder(join(f.paths.stateRoot, 'apply.lock')), undefined);
});


test('a service respawn between shutdown and bootout is drained before native readiness', async t => {
  const f = fixture(t); f.respawn();
  await f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }, { action: 'begin-install', installerPid: 777777 }, { action: 'commit' }), stdout: value => {
    if ((value as { ready?: boolean }).ready) assert.equal(liveLockHolder(join(f.paths.stateRoot, 'agent/agent.lock')), undefined);
  }, connect: f.connect, pollMs: 1, timeoutMs: 100 }));
});

test('changed service registration cannot authorize unloading an unrelated job', async t => {
  const f = fixture(t); writeFileSync(unitPath(f.input.target), 'an unrelated service');
  await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }), stdout: () => {}, connect: f.connect })), /registration|app-owned/);
  assert.deepEqual(f.events, []); assert.ok(!existsSync(f.journalPath));
});

test('explicit old-version recovery can restore an intact installing bundle and reports interruption', async t => {
  const f = fixture(t);
  await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }, { action: 'begin-install', installerPid: 777777 }), stdout: () => {}, connect: f.connect })), /EOF/);
  assert.deepEqual(await f.run(maintenance.recoverUpdate(f.input, { stdin: records({ appVersion: '1.0.0' }), connect: f.connect, installerAlive: () => false, retryDelayMs: 0 })), { recovered: true, interrupted: true, stateRoot: f.paths.stateRoot });
  assert.ok(!existsSync(f.journalPath));
});

test('changed old app bytes refuse recovery even if version and runtime metadata are unchanged', async t => {
  const f = fixture(t);
  await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }, { action: 'begin-install', installerPid: 777777 }), stdout: () => {}, connect: f.connect })), /EOF/);
  writeFileSync(f.appPath, 'modified executable'); f.events.length = 0;
  await assert.rejects(f.run(maintenance.recoverUpdate(f.input, { stdin: records({ appVersion: '1.0.0' }), connect: f.connect, installerAlive: () => false })), /intact old bundle/);
  assert.deepEqual(f.events, []); assert.ok(existsSync(f.journalPath));
});

test('unchanged registration retains every nonmetadata byte including nested JSON formatting', async t => {
  const f = fixture(t); const path = join(f.paths.stateRoot, 'agent/agent.json'); const raw = JSON.parse(readFileSync(path, 'utf8')); raw.future = ['a,}:\\"', { extra: true }];
  const text = JSON.stringify(raw, null, 4) + '\n\n'; writeFileSync(path, text);
  await f.run(ensureAgent(f.input, { restart: true, connect: f.connect, retryDelayMs: 0 }));
  assert.equal(readFileSync(path, 'utf8'), text);
});

test('authority and journal fields never coerce array values into valid strings', async t => {
  const f = fixture(t); const path = join(f.paths.stateRoot, 'agent/agent.json'); const raw = JSON.parse(readFileSync(path, 'utf8')); raw.policySource = ['person']; writeFileSync(path, JSON.stringify(raw));
  await assert.rejects(f.run(ensureAgent(f.input, { restart: true, connect: f.connect, retryDelayMs: 0 })), /invalid/);
  raw.policySource = 'person'; writeFileSync(path, JSON.stringify(raw));
  await f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }, { action: 'begin-install', installerPid: 777777 }, { action: 'commit' }), stdout: () => {}, connect: f.connect }));
  const journal = JSON.parse(readFileSync(f.journalPath, 'utf8')); journal.oldBundleHash = [journal.oldBundleHash]; writeFileSync(f.journalPath, JSON.stringify(journal));
  assert.equal((await f.run(maintenance.maintenanceState(f.input))).phase, null);
});

test('successful old service registration retains prepared pending when fresh IPC health is unavailable or wrong', async t => {
  for (const failure of ['unavailable', 'wrong-version', 'wrong-protocol'] as const) {
    const f = fixture(t); let connects = 0;
    const connect = async (): Promise<AgentConnection> => {
      if (++connects === 1) return f.connect();
      assert.equal(liveLockHolder(join(f.paths.stateRoot, 'agent/app-install.lock')), process.pid);
      assert.equal(liveLockHolder(join(f.paths.stateRoot, 'apply.lock')), process.pid);
      if (failure === 'unavailable') throw new AgentUnavailable('fresh service not ready');
      const conn = await f.connect();
      return { ...conn, hello: { ...conn.hello, ...(failure === 'wrong-version' ? { agentVersion: 'wrong' } : { protocol: 2 }) } } as AgentConnection;
    };
    await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }, { action: 'abort' }), stdout: () => {}, connect, timeoutMs: 50, pollMs: 1, retryDelayMs: 0 })), /health.*timed out|health identity/);
    assert.ok(f.events.includes('bootstrap')); assert.equal(JSON.parse(readFileSync(f.journalPath, 'utf8')).phase, 'prepared');
    assert.equal(liveLockHolder(join(f.paths.stateRoot, 'apply.lock')), undefined);
  }
});

test('prepared EOF retains pending when the restarted service fails fresh health', async t => {
  const f = fixture(t); let connects = 0;
  const connect = async (): Promise<AgentConnection> => {
    if (++connects === 1) return f.connect();
    throw new AgentUnavailable('not ready');
  };
  await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }), stdout: () => {}, connect, timeoutMs: 50, pollMs: 1, retryDelayMs: 0 })), /EOF/);
  assert.ok(existsSync(f.journalPath));
});

test('prepared restoration cancellation joins fresh health before releasing fences and preserves pending', async t => {
  const f = fixture(t); const controller = new AbortController(); let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }); let connects = 0;
  const connect = async (): Promise<AgentConnection> => {
    if (++connects === 2) { entered(); await new Promise(resolve => setTimeout(resolve, 40)); }
    return f.connect();
  };
  const running = f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }, { action: 'abort' }), stdout: () => {}, connect, timeoutMs: 200, pollMs: 1, retryDelayMs: 0 }), controller.signal);
  const rejected = assert.rejects(running);
  await ready; assert.ok(existsSync(f.journalPath)); controller.abort(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(liveLockHolder(join(f.paths.stateRoot, 'agent/app-install.lock')), process.pid);
  assert.equal(liveLockHolder(join(f.paths.stateRoot, 'apply.lock')), process.pid);
  await rejected;
  assert.ok(existsSync(f.journalPath)); assert.equal(liveLockHolder(join(f.paths.stateRoot, 'apply.lock')), undefined);
  assert.equal(f.events.filter(event => event === 'bootstrap').length, 1, 'failed restoration is not repeated during interruption cleanup');
});

test('helper timeout after begin-install cannot recover intact old bytes while native installation still lives', async t => {
  const f = fixture(t); const stdin = { async *[Symbol.asyncIterator]() {
    yield JSON.stringify({ fromVersion: '1.0.0', toVersion: '1.1.0' }) + '\n';
    yield JSON.stringify({ action: 'begin-install', installerPid: 777777 }) + '\n';
    await new Promise(() => {});
  } };
  await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin, stdout: () => {}, connect: f.connect, sessionTimeoutMs: 15 })), /timed out|Timeout/);
  assert.equal(JSON.parse(readFileSync(f.journalPath, 'utf8')).installerPid, 777777);
  f.events.length = 0;
  await assert.rejects(f.run(maintenance.recoverUpdate(f.input, { stdin: records({ appVersion: '1.0.0' }), connect: f.connect, installerAlive: pid => { assert.equal(pid, 777777); return true; } })), /installer.*running|live installer/);
  assert.deepEqual(f.events, []); assert.ok(existsSync(f.journalPath));
  assert.deepEqual(await f.run(maintenance.recoverUpdate(f.input, { stdin: records({ appVersion: '1.0.0' }), connect: f.connect, installerAlive: () => false, retryDelayMs: 0 })), { recovered: true, interrupted: true, stateRoot: f.paths.stateRoot });
});

test('begin-install PID is strict and commit acknowledges completion without retaining a live installer fence', async t => {
  for (const installerPid of [0, -1, 1.5, '42', null, 2147483648]) assert.throws(() => decodeMaintenanceAction({ action: 'begin-install', installerPid }));
  assert.throws(() => decodeMaintenanceAction({ action: 'begin-install' }));
  assert.throws(() => decodeMaintenanceAction({ action: 'commit', installerPid: 42 }));
  const f = fixture(t);
  await f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }, { action: 'begin-install', installerPid: 777777 }, { action: 'commit' }), stdout: () => {}, connect: f.connect }));
  assert.equal(JSON.parse(readFileSync(f.journalPath, 'utf8')).installerPid, null);
});

test('injected durability failure denies native readiness or installing acknowledgement and retains pending', async t => {
  for (const failAt of [1, 3]) {
    let syncs = 0; const output: unknown[] = [];
    const f = fixture(t, { syncPath: path => ++syncs === failAt ? Effect.fail(new FsFailed({ op: 'sync', path, reason: 'injected durability failure' })) : Effect.void });
    await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }, { action: 'begin-install', installerPid: 777777 }), stdout: value => output.push(value), connect: f.connect })), /injected durability failure/);
    assert.ok(existsSync(f.journalPath)); assert.ok(!output.some(value => (value as { installing?: boolean }).installing));
    assert.equal(output.length, failAt === 1 ? 0 : 1);
    if (failAt === 1) assert.ok(!f.events.includes('shutdown'));
    assert.equal(liveLockHolder(join(f.paths.stateRoot, 'apply.lock')), undefined);
  }
});

test('an injected backup digest mismatch denies shutdown and native readiness', async t => {
  let hashes = 0; const output: unknown[] = [];
  const f = fixture(t, { digestTree: () => Effect.succeed((++hashes === 1 ? 'a' : 'b').repeat(64)) });
  await assert.rejects(f.run(maintenance.prepareUpdate(f.input, { stdin: records({ fromVersion: '1.0.0', toVersion: '1.1.0' }), stdout: value => output.push(value), connect: f.connect })), /changed while backing up/);
  assert.deepEqual(output, []); assert.ok(!f.events.includes('shutdown')); assert.ok(!existsSync(f.journalPath));
});
