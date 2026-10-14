import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { Backups, Fs, FsFailed, machinePaths, nodeFs, Processes, type Command } from '@nortuscc/machine';
import { SetupSource } from '@nortuscc/sync';
import { configMachine } from '../../../packages/machine/checks/config-machine.ts';
import { connectHost, disconnectHost, inspectConnections, repairConnections } from '../agent/mcp-connections.ts';

const codexEntry = (path: string) => ({ name: 'nortuscc', enabled: true, disabled_reason: null,
  transport: { type: 'stdio', command: path, args: ['--mcp'], env: null, env_vars: [], cwd: null },
  enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null });
async function fixture(t: TestContext, customClaude = false, customCodex = false) {
  const m = configMachine(); t.after(() => rmSync(m.root, { recursive: true, force: true })); await m.sync();
  const paths = { ...m.paths, ...(customClaude ? { claude: join(m.root, 'custom-claude') } : {}), ...(customCodex ? { codex: join(m.root, 'selected-codex') } : {}) };
  const input = { home: m.root, appPath: join(m.root, 'An app $(no shell).app/Contents/MacOS/Nortuscc') };
  m.write(join(paths.stateRoot, 'agent/agent.json'), JSON.stringify({ version: 1, installedBy: 'app', appPath: input.appPath, agentVersion: 'v1' }));
  const registry = (target: string) => target === 'codex' ? join(paths.codex, 'config.toml') : customClaude ? join(paths.claude, '.claude.json') : join(m.root, '.claude.json');
  const entries: Record<string, unknown> = {};
  const calls: Command[] = [];
  let beforeConfig: Record<string, string | undefined> = {};
  let failAfterWrite = false;
  let failBeforeWrite = false;
  let failInstructions = false;
  let mutateAfterBackup: (() => void) | undefined;
  let beforeMutation: (() => void) | undefined;
  const processes = Layer.succeed(Processes, { run: (c: Command) => Effect.sync(() => {
    calls.push(c);
    if (c.args[0] === '--version') return { code: 0, stdout: 'test version' };
    if (c.args[1] === 'list') return { code: 0, stdout: JSON.stringify(entries.codex ? [{ name: 'nortuscc' }] : []) };
    if (c.args[1] === 'get') return { code: entries.codex ? 0 : 1, stdout: entries.codex ? JSON.stringify(entries.codex) : '' };
    if (failBeforeWrite) return { code: 1, stdout: '', stderr: 'private error' };
    assert.ok(['add', 'remove'].includes(c.args[1]!));
    assert.equal(c.output, 'capture'); assert.equal(c.stderr, 'capture');
    assert.ok(existsSync(join(paths.stateRoot, 'mcp-connections.json')), 'recoverable receipt precedes CLI mutation');
    if (beforeConfig[c.cmd]) {
      const backups = readdirSync(paths.backups, { recursive: true }).filter(p => typeof p === 'string').map(String);
      assert.ok(backups.some(p => { try { return readFileSync(join(paths.backups, p), 'utf8') === beforeConfig[c.cmd]; } catch { return false; } }), 'exact live config backed up before CLI mutation');
    }
    beforeMutation?.();
    if (c.cmd === 'codex') {
      if (c.args[1] === 'add') entries.codex = codexEntry(c.args[c.args.indexOf('--') + 1]!); else delete entries.codex;
      m.write(registry('codex'), '# unrelated config\n' + JSON.stringify(entries.codex ?? null));
    } else {
      const raw = JSON.parse(m.read(registry('claude')) ?? '{"theme":"kept","mcpServers":{}}');
      if (c.args[1] === 'add') raw.mcpServers.nortuscc = { type: 'stdio', command: c.args[c.args.indexOf('--') + 1], args: ['--mcp'], env: {} };
      else delete raw.mcpServers.nortuscc;
      m.write(registry('claude'), JSON.stringify(raw));
    }
    return { code: failAfterWrite ? 1 : 0, stdout: '', stderr: 'private failure must not escape' };
  }) });
  const nativeFs = Effect.runSync(Fs.pipe(Effect.provide(nodeFs)));
  const fs = Layer.succeed(Fs, { ...nativeFs, writeTextAtomic: (path: string, text: string) => failInstructions && path.endsWith('AGENTS.md') ? Effect.fail(new FsFailed({ op: 'write', path, reason: 'test failure' })) : nativeFs.writeTextAtomic(path, text) });
  let desired = await m.desired(); let currentCalls = 0;
  const source = Layer.succeed(SetupSource, { current: Effect.sync(() => { currentCalls++; assert.ok(existsSync(join(paths.stateRoot, 'apply.lock'))); return { desired, repo: paths.repo }; }) } as any);
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> => { beforeConfig = { codex: m.read(registry("codex")), claude: m.read(registry("claude")) }; const base = Layer.mergeAll(m.layer(), processes, source, machinePaths(paths), fs); const backupLayer = Layer.effect(Backups, Effect.gen(function* () { const b = yield* Backups; return { ...b, preserve: (...args: Parameters<typeof b.preserve>) => b.preserve(...args).pipe(Effect.tap(() => Effect.sync(() => mutateAfterBackup?.()))) }; })).pipe(Layer.provideMerge(base)); return Effect.runPromise(effect.pipe(Effect.provide(backupLayer)) as Effect.Effect<A, E>); };
  return { ...m, paths, input, registry, entries, calls, run, setDesired: (v: typeof desired) => { desired = v; }, currentCalls: () => currentCalls,
    failInstructions: () => { failInstructions = true; }, afterBackup: (f: () => void) => { mutateAfterBackup = f; },
    failBeforeWrite: (v = true) => { failBeforeWrite = v; }, failAfterWrite: () => { failAfterWrite = true; }, beforeMutation: (f: () => void) => { beforeMutation = f; } };
}

test('Codex connect uses selected home and argv, records configuration without claiming a host session, and disconnect preserves other config', async t => {
  const f = await fixture(t); f.write(f.registry('codex'), '# unrelated config\n');
  const result = await f.run(connectHost({ ...f.input, target: 'codex' }));
  assert.equal(result.registration, 'configured'); assert.equal(result.routing.status, 'installed');
  assert.equal(result.session, 'unobserved'); assert.equal(result.reload, 'recommended');
  const add = f.calls.find(c => c.args[1] === 'add')!;
  assert.deepEqual(add.args, ['mcp', 'add', 'nortuscc', '--', f.input.appPath, '--mcp']);
  assert.equal(add.env?.CODEX_HOME, f.paths.codex); assert.equal(add.env?.HOME, f.root);
  assert.ok(f.currentCalls() > 0);
  const removed = await f.run(disconnectHost({ ...f.input, target: 'codex' }));
  assert.equal(removed.registration, 'absent'); assert.equal(removed.routing.status, 'released');
  assert.match(f.read(f.registry('codex'))!, /unrelated config/);
});

for (const custom of [false, true]) test(`Claude uses user scope and the ${custom ? 'custom' : 'default'} native registry`, async t => {
  const f = await fixture(t, custom);
  f.write(f.registry('claude'), '{"theme":"kept","mcpServers":{"other":{"command":"untouched"}}}');
  const result = await f.run(connectHost({ ...f.input, target: 'claude' }));
  assert.equal(result.registration, 'configured');
  const add = f.calls.find(c => c.args[1] === 'add')!;
  assert.deepEqual(add.args, ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'nortuscc', '--', f.input.appPath, '--mcp']);
  assert.equal(add.env?.CLAUDE_CONFIG_DIR, custom ? f.paths.claude : '');
  await f.run(disconnectHost({ ...f.input, target: 'claude' }));
  assert.deepEqual(JSON.parse(f.read(f.registry('claude'))!), { theme: 'kept', mcpServers: { other: { command: 'untouched' } } });
});

test('foreign and edited registrations survive connect, disconnect and relocation', async t => {
  const f = await fixture(t); f.entries.codex = codexEntry(f.input.appPath);
  assert.equal((await f.run(connectHost({ ...f.input, target: 'codex' }))).registration, 'conflict');
  assert.equal(f.calls.filter(c => ['add', 'remove'].includes(c.args[1]!)).length, 0);
  delete f.entries.codex; await f.run(connectHost({ ...f.input, target: 'codex' }));
  (f.entries.codex as any).transport.env = { SECRET: 'must stay private' };
  const result = await f.run(disconnectHost({ ...f.input, target: 'codex' }));
  assert.equal(result.registration, 'conflict'); assert.ok(!JSON.stringify(result).includes('SECRET'));
  const moved = { ...f.input, appPath: join(f.root, 'moved/Nortuscc') };
  f.write(join(f.paths.stateRoot, 'agent/agent.json'), JSON.stringify({ installedBy: 'app', appPath: moved.appPath }));
  const repaired = await f.run(repairConnections(moved));
  assert.equal(repaired.connections.length, 0, 'disconnect released lifecycle ownership');
  assert.equal((f.entries.codex as any).transport.command, f.input.appPath);
});

test('relocation repairs only active owned registration and does not recreate missing routing', async t => {
  const f = await fixture(t); await f.run(connectHost({ ...f.input, target: 'codex' }));
  f.write(join(f.paths.codex, 'AGENTS.md'), 'user removed guidance');
  const moved = { ...f.input, appPath: join(f.root, 'moved/Nortuscc') };
  f.write(join(f.paths.stateRoot, 'agent/agent.json'), JSON.stringify({ installedBy: 'app', appPath: moved.appPath }));
  const result = await f.run(repairConnections(moved));
  assert.equal(result.connections[0]?.registration, 'configured');
  assert.equal(f.read(join(f.paths.codex, 'AGENTS.md')), 'user removed guidance');
  assert.equal(f.calls.filter(c => c.cmd === 'claude').length, 0);
  await f.run(disconnectHost({ ...moved, target: 'codex' }));
  assert.equal((await f.run(repairConnections(f.input))).connections.length, 0);
});

test('fresh inspection recovers a CLI failure after a successful physical write', async t => {
  const f = await fixture(t); f.failAfterWrite();
  assert.equal((await f.run(connectHost({ ...f.input, target: 'codex' }))).registration, 'configured');
  assert.equal((await f.run(disconnectHost({ ...f.input, target: 'codex' }))).registration, 'absent');
});

test('current unmanaged config offers copy text, and pending maintenance blocks native mutations', async t => {
  const f = await fixture(t);
  f.setDesired(await f.desired({ source: 'overrides.json', value: { manageConfig: false }, issues: [] }));
  const result = await f.run(connectHost({ ...f.input, target: 'codex' }));
  assert.equal(result.routing.status, 'unmanaged'); assert.match(result.routing.offeredText, /nortuscc/);
  f.write(join(f.paths.stateRoot, 'agent/pending-update.json'), '{}');
  await assert.rejects(f.run(disconnectHost({ ...f.input, target: 'codex' })), /maintenance/i);
  assert.ok(f.entries.codex);
});

test('failed removal stays repairable and a retry can retire the exact registration', async t => {
  const f = await fixture(t); await f.run(connectHost({ ...f.input, target: 'codex' }));
  f.failBeforeWrite();
  const partial = await f.run(disconnectHost({ ...f.input, target: 'codex' }));
  assert.equal(partial.registration, 'repair-needed'); assert.equal(partial.routing.status, 'released');
  f.failBeforeWrite(false);
  assert.equal((await f.run(disconnectHost({ ...f.input, target: 'codex' }))).registration, 'absent');
});

test('failed instruction write reports configured registration and missing active routing independently', async t => {
  const f = await fixture(t); f.failInstructions();
  const partial = await f.run(connectHost({ ...f.input, target: 'codex' }));
  assert.equal(partial.registration, 'configured'); assert.equal(partial.routing.status, 'missing');
  assert.equal(partial.routing.intent, 'active'); assert.equal(partial.routing.blockStatus, 'absent');
});

test('a same-state registry change after backup refuses mutation', async t => {
  const f = await fixture(t); f.write(f.registry('codex'), '# before\n');
  f.afterBackup(() => f.write(f.registry('codex'), '# changed externally\n'));
  const result = await f.run(connectHost({ ...f.input, target: 'codex' }));
  assert.equal(result.registration, 'conflict');
  assert.equal(f.calls.filter(c => ['add', 'remove'].includes(c.args[1]!)).length, 0);
  assert.equal(f.read(f.registry('codex')), '# changed externally\n');
});

test('malformed ownership stays intact and inspection exposes no raw record', async t => {
  const f = await fixture(t); const path = join(f.paths.stateRoot, 'mcp-connections.json');
  const text = '{"version":1,"hosts":{"codex":{"secret":"private"}}}'; f.write(path, text);
  assert.equal((await f.run(connectHost({ ...f.input, target: 'codex' }))).registration, 'conflict');
  const state = await f.run(inspectConnections(f.input));
  assert.ok(state.connections.every(c => c.registration === 'conflict'));
  assert.doesNotMatch(JSON.stringify(state), /private|secret/); assert.equal(f.read(path), text);
});

test('fixed desktop helper resolves current checkout and invokes a fake executable in an isolated home', async t => {
  const { chmodSync, mkdirSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { runDesktopEntry } = await import('../agent/main.ts');
  const { nodeProcesses } = await import('@nortuscc/machine');
  const m = configMachine(); t.after(() => rmSync(m.root, { recursive: true, force: true })); await m.sync();
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: m.paths.repo, env: { HOME: m.root, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const appPath = join(m.root, 'Installed App/Nortuscc'); const resources = join(m.root, 'resources'); const bin = join(m.root, 'bin');
  m.write(join(resources, 'runtime.json'), JSON.stringify({ agentVersion: 'fixture-runtime' }));
  m.write(join(m.paths.stateRoot, 'agent/agent.json'), JSON.stringify({ version: 1, policy: 'notify', policySource: 'default', paused: null, installedBy: 'app', appPath, agentVersion: 'fixture-runtime' }));
  m.write(join(bin, 'codex'), `#!${process.execPath}\n` + `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const config = path.join(process.env.CODEX_HOME, 'config.toml');
let state = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, 'utf8')) : { unrelated: true };
fs.appendFileSync(path.join(process.env.HOME, 'calls.jsonl'), JSON.stringify({ args, home: process.env.HOME, codex: process.env.CODEX_HOME })+'\\n');
if (args[1] === 'list') console.log(JSON.stringify(state.entry ? [{ name: 'nortuscc' }] : []));
else if (args[1] === 'get') { if (!state.entry) process.exit(1); console.log(JSON.stringify(state.entry)); }
else if (args[1] === 'add') { const command = args[args.indexOf('--')+1]; state.entry = { name: 'nortuscc', enabled: true, disabled_reason: null, transport: { type: 'stdio', command, args: ['--mcp'], env: null, env_vars: [], cwd: null }, enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null }; fs.writeFileSync(config, JSON.stringify(state)); }
else if (args[1] === 'remove') { delete state.entry; fs.writeFileSync(config, JSON.stringify(state)); }
else process.exit(2);
`);
  chmodSync(join(bin, 'codex'), 0o755); mkdirSync(m.paths.codex, { recursive: true });
  m.write(join(m.paths.codex, 'config.toml'), '{"unrelated":true}');
  const env = { HOME: m.root, CODEX_HOME: '/unselected-codex', CLAUDE_CONFIG_DIR: '/unselected-claude', PATH: `${bin}:/usr/bin:/bin`, NORTUSCC_REPO_DIR: m.paths.repo, NORTUSCC_STATE_DIR: m.paths.stateRoot };
  const run = async (action: unknown) => {
    const out: string[] = []; const errors: string[] = [];
    const code = await runDesktopEntry({ args: ['--mcp-connections', '--app', appPath], env, resources, platform: 'darwin',
      processes: nodeProcesses({ env }), probe: async () => ({ env }), stdout: s => out.push(s), stderr: s => errors.push(s),
      stdin: { async *[Symbol.asyncIterator]() { yield JSON.stringify(action); } } });
    return { code, out, errors };
  };
  const connected = await run({ action: 'connect', target: 'codex' });
  assert.equal(connected.code, 0, connected.errors.join('')); assert.equal(connected.out.length, 1);
  assert.equal(JSON.parse(connected.out[0]!).connections[0].registration, 'configured');
  const calls = m.read(join(m.root, 'calls.jsonl'))!.trim().split('\n').map(s => JSON.parse(s));
  assert.ok(calls.every(c => c.home === m.root && c.codex === m.paths.codex));
  assert.ok(calls.some(c => JSON.stringify(c.args) === JSON.stringify(['mcp', 'add', 'nortuscc', '--', appPath, '--mcp'])));
  const disconnected = await run({ action: 'disconnect', target: 'codex' }); assert.equal(disconnected.code, 0, disconnected.errors.join(''));
  assert.deepEqual(JSON.parse(m.read(join(m.paths.codex, 'config.toml'))!), { unrelated: true });
  const rejected = await run({ action: 'connect', target: 'codex', appPath: '/foreign' });
  assert.equal(rejected.code, 1); assert.equal(rejected.out.length, 0);
});

test('disconnect retires owned guidance even when an edited registration must be preserved', async t => {
  const f = await fixture(t); await f.run(connectHost({ ...f.input, target: 'codex' }));
  (f.entries.codex as any).transport.command = '/owner/edited';
  const result = await f.run(disconnectHost({ ...f.input, target: 'codex' }));
  assert.equal(result.registration, 'conflict'); assert.equal(result.routing.status, 'released');
  assert.equal((f.entries.codex as any).transport.command, '/owner/edited');
});

test('selected custom Codex home owns the registry and leaves the default home untouched', async t => {
  const f = await fixture(t, false, true); f.write(join(f.root, '.codex/config.toml'), '# keep default');
  const result = await f.run(connectHost({ ...f.input, target: 'codex' })); assert.equal(result.registration, 'configured');
  const add = f.calls.find(c => c.args[1] === 'add')!; assert.equal(add.env?.CODEX_HOME, join(f.root, 'selected-codex'));
  assert.equal(f.read(join(f.root, '.codex/config.toml')), '# keep default');
  assert.equal(JSON.parse(f.read(join(f.paths.stateRoot, 'mcp-connections.json'))!).hosts.codex.registry, f.registry('codex'));
});

test('relocation preserves an edited owned registration and reports the conflict', async t => {
  const f = await fixture(t); await f.run(connectHost({ ...f.input, target: 'codex' }));
  (f.entries.codex as any).transport.args = ['--mcp', '--owner-edit'];
  const moved = { ...f.input, appPath: join(f.root, 'moved/Nortuscc') };
  f.write(join(f.paths.stateRoot, 'agent/agent.json'), JSON.stringify({ installedBy: 'app', appPath: moved.appPath }));
  const result = await f.run(repairConnections(moved));
  assert.equal(result.connections[0]?.registration, 'conflict');
  assert.equal(f.calls.filter(c => c.args[1] === 'remove').length, 0);
  assert.deepEqual((f.entries.codex as any).transport.args, ['--mcp', '--owner-edit']);
});

test('edited routing survives disconnect while its intent is retired and registration is removed', async t => {
  const f = await fixture(t); await f.run(connectHost({ ...f.input, target: 'codex' }));
  const path = join(f.paths.codex, 'AGENTS.md'); const edited = f.read(path)!.replace('For nortuscc', 'Owner edited nortuscc'); f.write(path, edited);
  const result = await f.run(disconnectHost({ ...f.input, target: 'codex' }));
  assert.equal(result.registration, 'absent'); assert.equal(result.routing.status, 'conflict');
  assert.equal(result.routing.intent, 'released'); assert.equal(f.read(path), edited);
});
