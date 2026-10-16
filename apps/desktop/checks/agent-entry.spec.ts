import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { Effect, Layer } from 'effect';
import { nodeProcesses, Processes, type Command, type MachinePathsValue } from '@nortuscc/machine';
import { HostedFailure, HostedTransport } from '@nortuscc/hosted-client';
import { AgentError, connectAgent, type AgentConnection } from '../../../src/agent-client.ts';
import { runDesktopEntry } from '../agent/main.ts';
import { STARTUP_PREFIX } from '../agent/startup-diagnostics.ts';
import { probeLoginEnvironment } from '../agent/login-environment.ts';
import { assertExited, assertReaped } from './support/processes.ts';

const fixture = (t: { after: (f: () => void) => void }) => {
  const home = mkdtempSync(join(tmpdir(), 'nae-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const resources = join(home, 'resources');
  const repo = join(home, 'repo');
  const stateRoot = join(home, 'state');
  mkdirSync(resources);
  const developer = join(resources, 'developer');
  mkdirSync(join(developer, 'usr/bin'), { recursive: true });
  writeFileSync(join(developer, 'usr/bin/git'), 'inert Git fixture');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(stateRoot);
  writeFileSync(join(resources, 'runtime.json'), JSON.stringify({ agentVersion: 'bundle-hash' }));
  writeFileSync(join(stateRoot, 'state.json'), JSON.stringify({ version: 1, repo, files: {} }));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: Command[] = [];
  const processes = Layer.succeed(Processes, { run: (command) => Effect.sync(() => {
    commands.push(command);
    if (command.cmd === '/usr/bin/xcode-select') return { code: 0, stdout: developer, stderr: '' };
    if (command.cmd === 'launchctl') return { code: 0, stdout: '', stderr: '' };
    assert.equal(command.cmd, 'git');
    return { code: 1, stdout: '', stderr: 'fixture has no commit' };
  }) });
  let probes = 0;
  const input = {
    args: ['--ensure', '--app', join(home, 'Nortuscc.app/Contents/MacOS/Nortuscc')], resources,
    env: { HOME: home, NORTUSCC_DESKTOP_LOCAL_ONLY: '1', SHELL: '/fake/shell', PATH: '/inherited', NORTUSCC_STATE_DIR: stateRoot },
    platform: 'darwin' as const, uid: 501, user: 'fixture', processes,
    // Stand-ins for Homebrew's prefixes, so a host's real tools there (CI runners carry git) stay out of fake Processes.
    toolDirectories: [join(home, 'homebrew/bin'), join(home, 'local/bin')],
    hostedDependencies: { keychain: { read: () => Effect.succeed(undefined), write: () => Effect.void, remove: () => Effect.void },
      transport: Layer.succeed(HostedTransport, { request: () => Effect.fail(new HostedFailure({ code: 'network' })) }) },
    probe: async () => { probes++; return { env: { HOME: home, PATH: '/login/bin', NORTUSCC_STATE_DIR: stateRoot } }; },
    stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line),
  };
  const paths: MachinePathsValue = { repo, stateRoot, backups: join(stateRoot, 'backups'), claude: join(home, '.claude'), codex: join(home, '.codex'), codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents/skills') };
  return { input, home, repo, stateRoot, paths, stdout, stderr, commands, probes: () => probes };
};

const startupRecords = (lines: ReadonlyArray<string>) => lines.filter(line => line.startsWith(STARTUP_PREFIX)).map(line => JSON.parse(line.slice(STARTUP_PREFIX.length)));

test('paths helper emits safe phase timings while keeping its one-record stdout contract', async (t) => {
  const f = fixture(t);
  const secret = 'never-log-this-credential';
  assert.equal(await runDesktopEntry({ ...f.input, args: ['--paths'],
    probe: async () => ({ env: { HOME: f.home, PATH: '/fake', NORTUSCC_STATE_DIR: f.stateRoot, API_TOKEN: secret } }) }), 0);
  assert.deepEqual(f.stdout, [JSON.stringify({ stateRoot: f.stateRoot }) + '\n']);
  const records = startupRecords(f.stderr);
  assert.ok(records.some(r => r.phase === 'login_probe' && r.status === 'completed'));
  assert.ok(records.some(r => r.phase === 'paths' && r.status === 'completed'));
  assert.ok(records.some(r => r.phase === 'entry' && r.status === 'completed'));
  assert.ok(records.every(r => r.component === 'helper' && r.operation === 'paths' && Number.isSafeInteger(r.elapsedMs)));
  assert.equal(f.stderr.join('').includes(secret), false);
  assert.equal(f.stderr.join('').includes(f.home), false, 'structured diagnostics contain no paths');
  assert.deepEqual(f.commands, [], 'read-only helper does not register services');
});

test('the ensure helper resolves recorded checkout from login environment and prints exactly one result', async (t) => {
  const f = fixture(t);
  // The shipped tool directories; this helper never probes Git, so the host's tools there cannot reach fake Processes.
  assert.equal(await runDesktopEntry({ ...f.input, toolDirectories: undefined }), 0);
  assert.deepEqual(f.stdout, [JSON.stringify({ stateRoot: f.stateRoot }) + '\n']);
  assert.deepEqual(f.stderr.filter(line => !line.startsWith(STARTUP_PREFIX)), []);
  assert.equal(f.probes(), 1);
  assert.ok(f.commands.some((c) => c.cmd === 'launchctl'));
  assert.equal(JSON.parse(readFileSync(join(f.stateRoot, 'agent/agent.json'), 'utf8')).agentVersion, 'bundle-hash');
  // Homebrew's prefixes follow the login PATH, so a service finds gh and other tools a terminal would.
  assert.ok(readFileSync(join(f.home, 'Library/LaunchAgents/com.nortuscc.agent.plist'), 'utf8').includes('<string>/login/bin:/opt/homebrew/bin:/usr/local/bin</string>'));
});

test('missing recorded checkout refuses helper install instead of using bundled resource directory', async (t) => {
  const f = fixture(t);
  rmSync(join(f.stateRoot, 'state.json'));
  assert.equal(await runDesktopEntry(f.input), 1);
  assert.deepEqual(f.stdout, []);
  assert.deepEqual(f.commands, []);
  assert.ok(f.stderr.join('').includes('checkout') || f.stderr.join('').includes('repo'));
});

test('entry rejects resource version errors and arbitrary arguments before registration', async (t) => {
  const f = fixture(t);
  assert.equal(await runDesktopEntry({ ...f.input, args: ['--ensure', '/renderer/path'] }), 1);
  assert.deepEqual(f.commands, []);
  assert.equal(f.probes(), 0);
  writeFileSync(join(f.input.resources, 'runtime.json'), '{}');
  assert.equal(await runDesktopEntry(f.input), 1);
  assert.deepEqual(f.stdout, []);
  assert.deepEqual(f.commands, []);
});

test('foreground resource agent serves app hello and survives disconnect until shutdown', {
  skip: process.platform === 'win32' ? 'Windows agent IPC is unsupported (ADR 0019)' : false,
  timeout: 10000,
}, async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const running = runDesktopEntry({ ...f.input, args: [], signal: controller.signal });
  let conn: AgentConnection | undefined;
  const until = Date.now() + 5000;
  while (!conn && Date.now() < until) {
    try { conn = await connectAgent(f.paths, { client: 'app', timeoutMs: 100 }); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.ok(conn, f.stderr.join(''));
  assert.equal(conn.hello.agentVersion, 'bundle-hash');
  assert.equal(conn.hello.protocol, 3);
  conn.close();
  const second = await connectAgent(f.paths, { client: 'app' });
  try {
    let status: { applying?: boolean } | undefined;
    while (!status && Date.now() < until) {
      try { status = await second.request({ command: 'status' }); }
      catch (error) { if (!(error instanceof AgentError && error.code === 'NO_REPORT')) throw error; await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    assert.equal(status?.applying, false);
    await second.request({ command: 'shutdown' });
    assert.equal(await running, 0);
    assert.deepEqual(f.stdout, [], 'foreground stdout contains no lifecycle helper record');
    assert.ok(f.commands.every((c) => c.cmd !== 'launchctl'), 'foreground does not register a service');
    assert.equal(f.probes(), 1);
  } finally { second.close(); }
});

test('a real login timeout reports fallback and still reaches IPC readiness and scoped shutdown', {
  skip: process.platform === 'win32' ? 'requires Unix IPC and process groups' : false, timeout: 10000,
}, async t => {
  const f = fixture(t);
  const shell = join(f.home, 'slow-login-shell');
  writeFileSync(shell, '#!/bin/sh\n/bin/sleep 30\n'); chmodSync(shell, 0o755);
  const controller = new AbortController(); t.after(() => controller.abort());
  let now = 0;
  const originalNow = performance.now;
  t.after(() => { performance.now = originalNow; });
  performance.now = () => now;
  let expire: (() => void) | undefined;
  let deadlineCleared = false;
  const running = runDesktopEntry({ ...f.input, args: [], signal: controller.signal,
    env: { ...f.input.env, SHELL: shell, API_TOKEN: 'secret-never-in-trace' },
    probe: input => probeLoginEnvironment({ ...input, timeoutMs: 100,
      scheduleTimeout: (callback, ms) => {
        assert.equal(ms, 100); expire = callback;
        return () => { deadlineCleared = true; };
      },
      onProgress: (phase, status) => {
        input.onProgress?.(phase, status);
        if (phase === 'shell_ready' && status === 'started') { now = 100; expire!(); }
      } }) });
  let conn: AgentConnection | undefined;
  try {
    const until = Date.now() + 3000;
    while (!conn && Date.now() < until) {
      try { conn = await connectAgent(f.paths, { client: 'app', timeoutMs: 100 }); }
      catch { await new Promise(done => setTimeout(done, 10)); }
    }
    assert.ok(conn, f.stderr.join(''));
    const ready = startupRecords(f.stderr);
    assert.ok(ready.some(r => r.phase === 'shell_ready' && r.status === 'timed_out'));
    assert.ok(ready.some(r => r.phase === 'login_probe' && r.status === 'fallback' && r.durationMs === 100));
    assert.equal(deadlineCleared, true);
    assert.ok(ready.some(r => r.phase === 'probe_cleanup' && r.status === 'completed'));
    assert.ok(ready.some(r => r.phase === 'ipc' && r.status === 'completed'));
    assert.equal(f.stderr.join('').includes('secret-never-in-trace'), false);
    await conn.request({ command: 'shutdown' });
    assert.equal(await running, 0);
    const stopped = startupRecords(f.stderr);
    assert.ok(stopped.some(r => r.phase === 'shutdown' && r.status === 'started'));
    assert.ok(stopped.some(r => r.phase === 'ipc_closed' && r.status === 'completed'));
    assert.ok(stopped.some(r => r.phase === 'stopped' && r.status === 'completed'));
    assert.deepEqual(f.stdout, []);
    assert.ok(f.commands.every(c => c.cmd === 'git'), 'no real service/keychain/notification command');
  } finally { conn?.close(); controller.abort(); await running; }
});

test('registered service hands selected SHELL and startup directory to its foreground probe', async (t) => {
  const f = fixture(t);
  const shell = '/fake/selected-shell';
  const zdotdir = join(f.home, 'shell-startup');
  const config = join(f.home, 'shell-config');
  const startup = join(f.home, 'shell-rc');
  const env = { ...f.input.env, SHELL: shell, ZDOTDIR: zdotdir, XDG_CONFIG_HOME: config, ENV: startup };
  const helperProbe = async () => ({ env: { HOME: f.home, PATH: '/login/bin', NORTUSCC_STATE_DIR: f.stateRoot, SHELL: '/fake/different-export' } });
  assert.equal(await runDesktopEntry({ ...f.input, env, probe: helperProbe }), 0);
  const unit = readFileSync(join(f.home, 'Library/LaunchAgents/com.nortuscc.agent.plist'), 'utf8');
  const handoff = Object.fromEntries([...unit.matchAll(/<key>(SHELL|ZDOTDIR|XDG_CONFIG_HOME|ENV)<\/key>\s*<string>(.*?)<\/string>/g)].map((match) => [match[1]!, match[2]!]));
  assert.deepEqual(handoff, { SHELL: shell, ZDOTDIR: zdotdir, XDG_CONFIG_HOME: config, ENV: startup });
  const controller = new AbortController();
  let probed = false;
  const foreground = runDesktopEntry({
    ...f.input, args: [], platform: process.platform, signal: controller.signal,
    env: { HOME: f.home, NORTUSCC_DESKTOP_LOCAL_ONLY: '1', PATH: '/login/bin', NORTUSCC_STATE_DIR: f.stateRoot, ...handoff },
    probe: async (input) => {
      assert.equal(input.env.SHELL, shell);
      assert.equal(input.env.ZDOTDIR, zdotdir);
      assert.equal(input.env.XDG_CONFIG_HOME, config);
      assert.equal(input.env.ENV, startup);
      probed = true;
      controller.abort();
      return { env: Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) };
    },
  });
  assert.equal(await foreground, 0, f.stderr.join(''));
  assert.equal(probed, true);
});

test('startup selectors introduced by the helper probe remain absent before the foreground probe', {
  skip: process.platform === 'win32' ? 'requires a POSIX Git wrapper and Unix agent IPC (ADR 0019)' : false,
}, async (t) => {
  const f = fixture(t);
  const bin = join(f.home, 'bin');
  mkdirSync(bin);
  const observed = join(f.home, 'machine.env');
  const git = join(bin, 'git');
  // Readers must see a complete snapshot even while another Git probe runs.
  writeFileSync(git, `#!/bin/sh\nprintf '%s\\n' "$ZDOTDIR" "$XDG_CONFIG_HOME" "$ENV" "$SOURCE_PREREQUISITE" > "${observed}.$$"\n/bin/mv "${observed}.$$" "${observed}"\nexit 1\n`);
  chmodSync(git, 0o755);
  const exported = {
    HOME: f.home, PATH: bin, NORTUSCC_STATE_DIR: f.stateRoot, SHELL: '/fake/post-probe-shell',
    ZDOTDIR: join(f.home, 'alternate'), XDG_CONFIG_HOME: join(f.home, 'alternate-config'), ENV: join(f.home, 'alternate-rc'),
    SOURCE_PREREQUISITE: 'provided by original startup',
  };
  assert.equal(await runDesktopEntry({ ...f.input, probe: async () => ({ env: exported }) }), 0);
  const unit = readFileSync(join(f.home, 'Library/LaunchAgents/com.nortuscc.agent.plist'), 'utf8');
  const handoff = Object.fromEntries([...unit.matchAll(/<key>(SHELL|ZDOTDIR|XDG_CONFIG_HOME|ENV)<\/key>\s*<string>(.*?)<\/string>/g)].map((match) => [match[1]!, match[2]!]));
  assert.deepEqual(handoff, { SHELL: f.input.env.SHELL });
  const controller = new AbortController();
  let probed = false;
  const foreground = runDesktopEntry({
    ...f.input, args: [], processes: Layer.succeed(Processes, { run: (command) => command.cmd === 'git'
      ? Processes.use((processes) => processes.run(command)).pipe(Effect.provide(nodeProcesses({ env: exported, inherit: 'stderr' })))
      : Effect.succeed({ code: 1, stdout: '', stderr: 'notification unavailable in fixture' }) }), signal: controller.signal,
    env: { HOME: f.home, NORTUSCC_DESKTOP_LOCAL_ONLY: '1', PATH: '/login/bin', NORTUSCC_STATE_DIR: f.stateRoot, ...handoff },
    probe: async (input) => {
      assert.equal(input.env.ZDOTDIR, undefined);
      assert.equal(input.env.XDG_CONFIG_HOME, undefined);
      assert.equal(input.env.ENV, undefined);
      probed = true;
      return { env: exported };
    },
  });
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(observed) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
    assert.equal(probed, true);
    assert.equal(readFileSync(observed, 'utf8'), [exported.ZDOTDIR, exported.XDG_CONFIG_HOME, exported.ENV, exported.SOURCE_PREREQUISITE, ''].join('\n'));
  } finally {
    controller.abort();
    assert.equal(await foreground, 0, f.stderr.join(''));
  }
});

test('paths helper resolves login environment without resources, registration or inspection', async (t) => {
  const f = fixture(t);
  rmSync(join(f.input.resources, 'runtime.json'));
  rmSync(join(f.stateRoot, 'state.json'));
  assert.equal(await runDesktopEntry({ ...f.input, args: ['--paths'] }), 0);
  assert.deepEqual(f.stdout, [JSON.stringify({ stateRoot: f.stateRoot }) + '\n']);
  assert.equal(f.probes(), 1);
  assert.deepEqual(f.commands, []);
  assert.equal(existsSync(join(f.stateRoot, 'agent')), false);
  const currentRoot = join(f.home, 'current-login-state');
  assert.equal(await runDesktopEntry({ ...f.input, args: ['--paths'],
    probe: async () => ({ env: { HOME: f.home, NORTUSCC_STATE_DIR: currentRoot } }) }), 0);
  assert.equal(f.stdout.at(-1), JSON.stringify({ stateRoot: currentRoot }) + '\n');
  assert.equal(existsSync(currentRoot), false);
});

test('helper argv rejects missing, relative, extra and control-character app paths before probe', async (t) => {
  const f = fixture(t);
  for (const args of [ ['--ensure'], ['--restart', '--app', 'relative'], ['--ensure', '--app', '/app', '--paths'], ['--paths', '--app', '/app'], ['--ensure', '--app', '/bad\napp'] ]) {
    assert.equal(await runDesktopEntry({ ...f.input, args }), 1);
  }
  assert.equal(f.probes(), 0);
  assert.deepEqual(f.commands, []);
});

test('foreground hosted opt-in comes from login environment and invalid URL keeps IPC available', {
  skip: process.platform === 'win32' ? 'Unix IPC only' : false, timeout: 10000,
}, async (t) => {
  const f = fixture(t); const controller = new AbortController(); t.after(() => controller.abort());
  const running = runDesktopEntry({ ...f.input, env: { ...f.input.env, NORTUSCC_DESKTOP_LOCAL_ONLY: undefined }, args: [], signal: controller.signal,
    probe: async () => ({ env: { HOME: f.home, PATH: '/fake', NORTUSCC_STATE_DIR: f.stateRoot, NORTUSCC_HOSTED_URL: 'http://invalid/v1' } }) });
  let conn: AgentConnection | undefined;
  for (let n = 0; n < 100 && !conn; n++) {
    try { conn = await connectAgent(f.paths, { timeoutMs: 50 }); } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.ok(conn, f.stderr.join(''));
  try {
    const hosted = await conn.request<{ enabled: boolean; error: string }>({ command: 'hostedState' });
    assert.equal(hosted.enabled, true); assert.equal(hosted.error, 'invalid_url');
    assert.ok(f.commands.every((c) => c.cmd === 'git'), 'no keychain or service manager');
    await conn.request({ command: 'shutdown' });
  } finally { conn.close(); controller.abort(); }
  assert.equal(await running, 0);
});

test('setup helpers are available before a checkout or runtime metadata and bootstrap stdin is strict and bounded', async (t) => {
  const f = fixture(t);
  rmSync(join(f.stateRoot, 'state.json')); rmSync(join(f.input.resources, 'runtime.json'));
  assert.equal(await runDesktopEntry({ ...f.input, args: ['--setup-state'] }), 0);
  assert.deepEqual(JSON.parse(f.stdout.at(-1)!), { needsSetup: true, repo: null, gitAvailable: true, canInstallGit: true,
    defaultRepoUrl: 'https://github.com/Nortus222/claude-config.git' });
  const stdin = async function* (text: string) { yield text; };
  for (const text of ['{"configTargets":[],"path":"/tmp"}', '{bad', 'x'.repeat(4097)]) {
    assert.equal(await runDesktopEntry({ ...f.input, args: ['--bootstrap', '--app', '/native/app'], stdin: stdin(text) }), 1);
  }
  assert.ok(f.commands.every((command) => command.cmd === '/usr/bin/xcode-select'));
  assert.equal(await runDesktopEntry({ ...f.input, args: ['--install-git'] }), 0);
  assert.deepEqual(JSON.parse(f.stdout.at(-1)!), { requested: true });
  assert.ok(f.commands.at(-1)?.args.includes('--install'));
});

test('setup state finds Git in a Homebrew directory the login PATH lacks', async (t) => {
  const f = fixture(t);
  rmSync(join(f.stateRoot, 'state.json'));
  const brew = join(f.home, 'brew-bin');
  mkdirSync(brew);
  writeFileSync(join(brew, 'git'), '#!/bin/sh\n');
  chmodSync(join(brew, 'git'), 0o755);
  const ran: Command[] = [];
  const processes = Layer.succeed(Processes, { run: (command: Command) => Effect.sync(() => {
    ran.push(command);
    return { code: 0, stdout: 'git version 2.50.0', stderr: '' };
  }) });
  assert.equal(await runDesktopEntry({ ...f.input, args: ['--setup-state'], processes, toolDirectories: [brew] }), 0);
  assert.equal(JSON.parse(f.stdout.at(-1)!).gitAvailable, true);
  assert.deepEqual(ran.map((command) => command.cmd), [realpathSync(join(brew, 'git'))]);
});

test('a completed first-run clone survives failed service registration and retries without cloning or changing choices', async (t) => {
  const f = fixture(t); rmSync(join(f.stateRoot, 'state.json'));
  let failRegistration = true;
  const processes = Layer.succeed(Processes, { run: (command: Command) => Effect.sync(() => {
    f.commands.push(command);
    if (command.cmd === '/usr/bin/xcode-select') return { code: 0, stdout: join(f.input.resources, 'developer') };
    if (command.cmd === 'launchctl') return { code: command.args.includes('bootstrap') && failRegistration ? 1 : 0, stdout: '' };
    if (command.args.includes('clone')) {
      const repo = command.args.at(-1)!; mkdirSync(join(repo, '.git'), { recursive: true });
      writeFileSync(join(repo, 'integrations.json'), '{"version":1,"integrations":[]}'); writeFileSync(join(repo, 'skills-manifest.txt'), '');
    }
    return { code: 0, stdout: command.args.includes('get-url') || command.args.includes('--get') ? 'https://github.com/Nortus222/claude-config.git' : 'a'.repeat(40) };
  }) });
  const stdin = async function* () { yield '{"configTargets":["claude"]}'; };
  assert.equal(await runDesktopEntry({ ...f.input, processes, args: ['--bootstrap', '--app', '/native/app'], stdin: stdin() }), 0);
  const state = readFileSync(join(f.stateRoot, 'state.json'), 'utf8');
  assert.equal(await runDesktopEntry({ ...f.input, processes }), 1);
  assert.equal(readFileSync(join(f.stateRoot, 'state.json'), 'utf8'), state);
  failRegistration = false;
  assert.equal(await runDesktopEntry({ ...f.input, processes, args: ['--bootstrap', '--app', '/native/app'], stdin: stdin() }), 0);
  assert.equal(await runDesktopEntry({ ...f.input, processes }), 0);
  assert.equal(f.commands.filter((c) => c.args.includes('clone')).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(f.stateRoot, 'overrides.json'), 'utf8')).configTargets, ['claude']);
});

test('the whole bootstrap deadline starts before probing and refuses to clone after it expires', async (t) => {
  const f = fixture(t); rmSync(join(f.stateRoot, 'state.json'));
  const stdin = async function* () { yield '{"configTargets":[]}'; };
  const code = await runDesktopEntry({ ...f.input, args: ['--bootstrap', '--app', '/native/app'],
    bootstrapTimeoutMs: 10, stdin: stdin(),
    probe: async () => {
      await new Promise((done) => setTimeout(done, 30));
      return { env: { HOME: f.home, NORTUSCC_STATE_DIR: f.stateRoot } };
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(f.commands, [], 'expired setup never reaches Git or registration');
  assert.equal(existsSync(join(f.stateRoot, 'state.json')), false);
  assert.equal(existsSync(join(f.stateRoot, 'apply.lock')), false);
});

test('bootstrap cancellation joins a detached Git prerequisite before releasing the lock', {
  skip: process.platform === 'win32' ? 'POSIX executable fixture' : false, timeout: 15000,
}, async (t) => {
  const f = fixture(t); rmSync(join(f.stateRoot, 'state.json'));
  const bin = join(f.home, 'tools'); mkdirSync(bin);
  const pidFile = join(f.home, 'git.pid');
  const git = join(bin, 'git');
  writeFileSync(git, `#!${process.execPath}\nconst fs = require('node:fs');
process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')}, String(process.pid));
fs.renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)});\n`);
  chmodSync(git, 0o700);
  const stdin = async function* () { yield '{"configTargets":[]}'; };
  const env = { HOME: f.home, NORTUSCC_STATE_DIR: f.stateRoot, PATH: bin };
  const controller = new AbortController();
  let pid: number | undefined;
  const running = runDesktopEntry({ ...f.input, args: ['--bootstrap', '--app', '/native/app'],
    processes: undefined, platform: 'linux', env, probe: async () => ({ env }),
    signal: controller.signal, stdin: stdin(),
  });
  t.after(async () => {
    controller.abort();
    await running;
    if (pid !== undefined) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  });
  const readyDeadline = Date.now() + 5000;
  while (!existsSync(pidFile) && Date.now() < readyDeadline) await new Promise((done) => setTimeout(done, 10));
  assert.ok(existsSync(pidFile), 'fake Git prerequisite did not become ready');
  const recordedPid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isInteger(recordedPid) && recordedPid > 0);
  pid = recordedPid;
  const start = Date.now();
  controller.abort();
  assert.equal(await running, 1);
  const elapsed = Date.now() - start;
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  if (alive) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  assert.equal(alive, false, 'prerequisite child is joined before bootstrap returns');
  assert.ok(elapsed < 2500, `prerequisite cancellation took ${elapsed}ms`);
  assert.equal(existsSync(join(f.stateRoot, 'apply.lock')), false);
  assert.equal(existsSync(join(f.stateRoot, 'state.json')), false);
});

test('the desktop default enables signed-out account controls without signing in, trusting or contacting the service', {
  skip: process.platform === 'win32' ? 'Unix IPC only' : false, timeout: 10000,
}, async (t) => {
  const f = fixture(t); const controller = new AbortController(); t.after(() => controller.abort());
  let requests = 0;
  const running = runDesktopEntry({ ...f.input, args: [], env: { ...f.input.env, NORTUSCC_DESKTOP_LOCAL_ONLY: undefined },
    signal: controller.signal, hostedDependencies: {
      keychain: { read: () => Effect.succeed(undefined), write: () => Effect.die('unexpected token write'), remove: () => Effect.die('unexpected token remove') },
      transport: Layer.succeed(HostedTransport, { request: () => Effect.sync(() => { requests++; throw new Error('unexpected hosted request'); }) }),
    } });
  let conn: AgentConnection | undefined;
  for (let n = 0; n < 100 && !conn; n++) {
    try { conn = await connectAgent(f.paths, { timeoutMs: 50 }); } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.ok(conn, f.stderr.join(''));
  try {
    const hosted = await conn.request<{ enabled: boolean; auth: string; signingIn: boolean }>({ command: 'hostedState' });
    assert.equal(hosted.enabled, true); assert.equal(hosted.auth, 'signed-out'); assert.equal(hosted.signingIn, false);
    assert.equal(requests, 0);
    assert.equal(existsSync(join(f.stateRoot, 'agent/setups.json')), false);
    await conn.request({ command: 'shutdown' });
  } finally { conn.close(); controller.abort(); }
  assert.equal(await running, 0, f.stderr.join(''));
});

test('maintenance state remains readable before setup without service manager actions', async t => {
  const f = fixture(t); rmSync(join(f.stateRoot, 'state.json'));
  assert.equal(await runDesktopEntry({ ...f.input, args: ['--maintenance-state', '--app', f.input.args[2]!] }), 0);
  assert.deepEqual(JSON.parse(f.stdout.at(-1)!), { pending: false, phase: null, fromVersion: null, toVersion: null, backupPath: null, diagnostic: null });
  assert.deepEqual(f.commands, []);
});

test('cancelled maintenance helper returns bounded failure without an unhandled interruption', async t => {
  const f = fixture(t); const controller = new AbortController(); controller.abort();
  const stdin = async function* () { yield '{"fromVersion":"1.0.0","toVersion":"1.1.0"}\n'; };
  assert.equal(await runDesktopEntry({ ...f.input, args: ['--prepare-update', '--app', f.input.args[2]!], stdin: stdin(), signal: controller.signal }), 1);
  assert.deepEqual(f.commands, []);
});

test('signal cancellation of a promise-based helper is logged as cancellation at both boundaries', { timeout: 5000 }, async t => {
  const f = fixture(t);
  const controller = new AbortController(); t.after(() => controller.abort());
  let entered!: () => void;
  const invoked = new Promise<void>(done => { entered = done; });
  const processes = Layer.succeed(Processes, { run: () => Effect.sync(entered).pipe(Effect.andThen(Effect.never)) });
  const running = runDesktopEntry({ ...f.input, args: ['--install-git'], processes, signal: controller.signal });
  await invoked;
  controller.abort();
  assert.equal(await running, 1);
  const records = startupRecords(f.stderr);
  assert.ok(records.some(r => r.phase === 'lifecycle' && r.status === 'cancelled'));
  assert.equal(records.some(r => r.phase === 'lifecycle' && r.status === 'failed'), false);
  assert.ok(records.some(r => r.phase === 'entry' && r.status === 'cancelled'));
});

const startupInput = (f: ReturnType<typeof fixture>) => ({ ...f.input,
  args: ['--startup', '--app', f.input.args[2]!],
  stdin: { async *[Symbol.asyncIterator]() { yield JSON.stringify({ appVersion: '0.1.3' }); } },
});
const startupResult = (f: ReturnType<typeof fixture>) => {
  assert.equal(f.stdout.length, 1);
  return JSON.parse(f.stdout[0]!);
};

test('startup cancellation joins a real held login capture before returning without setup or service actions', {
  skip: process.platform === 'win32' ? 'requires detached POSIX process groups' : false, timeout: 10000,
}, async t => {
  const f = fixture(t);
  const shell = join(f.home, 'held-login-shell');
  const runtime = join(f.home, 'held-capture-runtime');
  const shellPid = join(f.home, 'shell.pid');
  const runtimePid = join(f.home, 'runtime.pid');
  writeFileSync(shell, `#!/bin/sh\necho $$ > '${shellPid}'\nexec /bin/sh -c "$2"\n`); chmodSync(shell, 0o755);
  writeFileSync(runtime, `#!/bin/sh\necho $$ > '${runtimePid}'\nexec /bin/sleep 30\n`); chmodSync(runtime, 0o755);
  const controller = new AbortController();
  const running = runDesktopEntry({ ...startupInput(f), signal: controller.signal,
    env: { ...f.input.env, SHELL: shell, API_TOKEN: 'private-capture-token' },
    probe: input => probeLoginEnvironment({ ...input, runtime, timeoutMs: 1000 }) });
  const pids: number[] = [];
  try {
    const until = Date.now() + 3000;
    while (!existsSync(runtimePid) && Date.now() < until) await new Promise(done => setTimeout(done, 10));
    assert.ok(existsSync(runtimePid), 'probe reached the held capture');
    pids.push(Number(readFileSync(shellPid, 'utf8')), Number(readFileSync(runtimePid, 'utf8')));
    controller.abort();
    assert.equal(await running, 1);
    assertReaped(pids[0]!, 'the login shell must be reaped before helper return');
    assertExited(pids[1]!, 'the capture runtime must exit before helper return');
    assert.deepEqual(f.stdout, []); assert.deepEqual(f.commands, []);
    const records = startupRecords(f.stderr);
    assert.ok(records.some(r => r.phase === 'probe_cleanup' && r.status === 'completed'));
    assert.ok(records.some(r => r.phase === 'login_probe' && r.status === 'cancelled'));
    assert.equal(records.some(r => r.phase === 'login_probe' && r.status === 'fallback'), false);
    assert.equal(records.some(r => r.phase === 'paths' || r.phase === 'setup_state' || r.phase === 'lifecycle'), false);
    assert.equal(f.stderr.join('').includes('private-capture-token'), false);
  } finally {
    controller.abort(); await running;
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
});

test('startup resolves one private login identity and refuses lifecycle for missing setup', async t => {
  const f = fixture(t);
  rmSync(join(f.stateRoot, 'state.json'));
  let probes = 0;
  const loginHome = join(f.home, 'login-home'); mkdirSync(loginHome);
  const loginState = join(loginHome, 'custom-state');
  const secret = 'secret-never-in-startup-context';
  assert.equal(await runDesktopEntry({ ...startupInput(f), probe: async input => {
    probes++; assert.equal(input.env.SHELL, '/fake/shell');
    return { env: { HOME: loginHome, NORTUSCC_STATE_DIR: loginState, PATH: '/login/bin', API_TOKEN: secret } };
  } }), 0);
  assert.equal(probes, 1);
  assert.deepEqual(startupResult(f), { stateRoot: loginState,
    setup: { needsSetup: true, repo: null, gitAvailable: true, canInstallGit: true, defaultRepoUrl: 'https://github.com/Nortus222/claude-config.git' },
    maintenance: { pending: false, phase: null, fromVersion: null, toVersion: null, backupPath: null, diagnostic: null }, outcome: 'needs_setup' });
  assert.ok(f.commands.every(c => c.cmd === '/usr/bin/xcode-select'), 'prerequisite reads never register a service');
  assert.equal(f.stdout.join('').includes(secret), false);
  assert.equal(f.stderr.join('').includes(secret), false);
  assert.equal(existsSync(join(loginState, 'agent/agent.json')), false);
});

test('startup preserves login state and original shell selectors when ensuring the service once', async t => {
  const f = fixture(t);
  const loginHome = join(f.home, 'login-home'); mkdirSync(loginHome);
  const selectors = { SHELL: '/fake/selected-shell', ZDOTDIR: join(f.home, 'selected-startup'), ENV: join(f.home, 'selected-env') };
  let probes = 0;
  assert.equal(await runDesktopEntry({ ...startupInput(f), env: { ...f.input.env, ...selectors }, probe: async input => {
    probes++; assert.equal(input.env.SHELL, selectors.SHELL);
    return { env: { HOME: loginHome, PATH: '/login/bin', NORTUSCC_STATE_DIR: f.stateRoot, SHELL: '/fake/exported-shell', ZDOTDIR: '/exported/startup', API_TOKEN: 'never-output-this' } };
  } }), 0);
  const result = startupResult(f);
  assert.equal(result.outcome, 'ready'); assert.equal(result.stateRoot, f.stateRoot);
  assert.equal(result.setup.repo, f.repo); assert.equal(result.maintenance.pending, false); assert.equal(probes, 1);
  const unit = readFileSync(join(loginHome, 'Library/LaunchAgents/com.nortuscc.agent.plist'), 'utf8');
  assert.ok(unit.includes('/login/bin')); assert.ok(unit.includes(loginHome));
  for (const value of Object.values(selectors)) assert.ok(unit.includes(value));
  assert.equal(unit.includes('/fake/exported-shell'), false); assert.equal(unit.includes('/exported/startup'), false);
  assert.equal(f.stdout.join('').includes('never-output-this'), false);
  assert.ok(f.commands.filter(c => c.cmd === 'launchctl').some(c => c.args[0] === 'bootstrap'));
});

test('startup rejects malformed native input and app arguments before probing or services', async t => {
  for (const text of ['{}', '{"appVersion":"0.1.3","env":{}}', '{"appVersion":"0.1.3-beta"}', 'null', '{"appVersion":"0.1.3"}\n{}', 'x'.repeat(4097)]) {
    const f = fixture(t);
    assert.equal(await runDesktopEntry({ ...startupInput(f), stdin: { async *[Symbol.asyncIterator]() { yield text; } } }), 1);
    assert.equal(f.probes(), 0); assert.deepEqual(f.commands, []); assert.deepEqual(f.stdout, []);
  }
  const f = fixture(t);
  assert.equal(await runDesktopEntry({ ...startupInput(f), args: ['--startup', '--app', 'relative'] }), 1);
  assert.equal(f.probes(), 0); assert.deepEqual(f.commands, []);
});

test('startup corrupt setup and runtime failures retain the root without lifecycle or raw output', async t => {
  const corrupt = fixture(t);
  writeFileSync(join(corrupt.stateRoot, 'state.json'), '{"API_TOKEN":"raw-private-secret"');
  assert.equal(await runDesktopEntry(startupInput(corrupt)), 0);
  assert.deepEqual(startupResult(corrupt), { stateRoot: corrupt.stateRoot, setup: null, maintenance: null, outcome: 'setup_failed' });
  assert.deepEqual(corrupt.commands, []); assert.equal(corrupt.stderr.join('').includes('raw-private-secret'), false);
  const runtime = fixture(t);
  writeFileSync(join(runtime.input.resources, 'runtime.json'), '{"error":"runtime-private-secret"}');
  assert.equal(await runDesktopEntry(startupInput(runtime)), 0);
  const result = startupResult(runtime);
  assert.equal(result.stateRoot, runtime.stateRoot); assert.equal(result.outcome, 'runtime_failed');
  assert.equal(result.setup.repo, runtime.repo); assert.equal(result.maintenance, null);
  assert.ok(runtime.commands.every(c => c.cmd === '/usr/bin/xcode-select'));
  assert.equal(runtime.stdout.join('').includes('runtime-private-secret'), false);
});

test('startup ensure failure retains setup and root while refusing readiness', async t => {
  const f = fixture(t);
  mkdirSync(join(f.stateRoot, 'agent'));
  writeFileSync(join(f.stateRoot, 'agent/agent.json'), '{"version":1,"policy":"broken-private-secret"}');
  assert.equal(await runDesktopEntry(startupInput(f)), 0);
  const result = startupResult(f);
  assert.equal(result.outcome, 'ensure_failed'); assert.equal(result.stateRoot, f.stateRoot);
  assert.equal(result.setup.repo, f.repo); assert.equal(result.maintenance.pending, false);
  assert.ok(f.commands.every(c => c.cmd === '/usr/bin/xcode-select'));
  assert.equal(f.stdout.join('').includes('broken-private-secret'), false);
});

test('startup retains a malformed journal and a live native installer without service mutation', async t => {
  for (const live of [false, true]) {
    const f = fixture(t); mkdirSync(join(f.stateRoot, 'agent'));
    const appPath = f.input.args[2]!;
    const journal = live ? JSON.stringify({ version: 1, phase: 'installing', appPath,
      bundlePath: join(f.home, 'Nortuscc.app'), fromVersion: '0.1.2', toVersion: '0.1.3',
      oldAgentVersion: 'a'.repeat(64), oldBundleHash: 'b'.repeat(64), backupPath: join(f.stateRoot, 'backups/old-app'), installerPid: process.pid }) : '{private-invalid-journal';
    writeFileSync(join(f.stateRoot, 'agent/pending-update.json'), journal);
    assert.equal(await runDesktopEntry(startupInput(f)), 0);
    const result = startupResult(f);
    assert.equal(result.outcome, 'recovery_failed'); assert.equal(result.stateRoot, f.stateRoot); assert.equal(result.maintenance.pending, true);
    assert.ok(f.commands.every(c => c.cmd === '/usr/bin/xcode-select'));
    assert.equal(readFileSync(join(f.stateRoot, 'agent/pending-update.json'), 'utf8'), journal);
    assert.equal(f.stdout.join('').includes('private-invalid-journal'), false);
  }
});

test('startup with missing setup retains a pending journal and never attempts recovery', async t => {
  const f = fixture(t); rmSync(join(f.stateRoot, 'state.json')); mkdirSync(join(f.stateRoot, 'agent'));
  writeFileSync(join(f.stateRoot, 'agent/pending-update.json'), '{invalid');
  assert.equal(await runDesktopEntry(startupInput(f)), 0);
  const result = startupResult(f);
  assert.equal(result.outcome, 'needs_setup'); assert.equal(result.setup.needsSetup, true); assert.equal(result.maintenance.pending, true);
  assert.ok(f.commands.every(c => c.cmd === '/usr/bin/xcode-select'));
  assert.equal(readFileSync(join(f.stateRoot, 'agent/pending-update.json'), 'utf8'), '{invalid');
});

test('startup cancellation emits no context and registers no service after a deferred probe', { timeout: 5000 }, async t => {
  const f = fixture(t); const controller = new AbortController();
  let entered!: () => void; let release!: () => void;
  const invoked = new Promise<void>(done => { entered = done; });
  const gate = new Promise<void>(done => { release = done; });
  const running = runDesktopEntry({ ...startupInput(f), signal: controller.signal, probe: async () => {
    entered(); await gate; return { env: { HOME: f.home, NORTUSCC_STATE_DIR: f.stateRoot } };
  } });
  await invoked; controller.abort(); release();
  assert.equal(await running, 1); assert.deepEqual(f.stdout, []); assert.deepEqual(f.commands, []);
  assert.ok(startupRecords(f.stderr).some(r => r.phase === 'entry' && r.status === 'cancelled'));
});

test('startup maintenance read failure preserves the resolved root and setup without ensuring', async t => {
  const f = fixture(t);
  mkdirSync(join(f.stateRoot, 'agent/pending-update.json'), { recursive: true });
  assert.equal(await runDesktopEntry(startupInput(f)), 0);
  const result = startupResult(f);
  assert.equal(result.stateRoot, f.stateRoot); assert.equal(result.outcome, 'maintenance_failed');
  assert.equal(result.setup.repo, f.repo); assert.equal(result.maintenance, null);
  assert.ok(f.commands.every(c => c.cmd === '/usr/bin/xcode-select'));
});

test('startup recovery verifies replacement health before clearing its journal and preserves user state', {
  skip: process.platform === 'win32' ? 'requires Unix agent IPC (ADR 0019)' : false, timeout: 10000,
}, async t => {
  const f = fixture(t);
  const bundle = join(realpathSync(f.home), 'Nortuscc.app');
  const resources = join(bundle, 'Contents/Resources/agent-runtime');
  const appPath = join(bundle, 'Contents/MacOS/Nortuscc');
  mkdirSync(resources, { recursive: true }); mkdirSync(join(bundle, 'Contents/MacOS'));
  writeFileSync(appPath, 'inert app executable'); writeFileSync(join(resources, 'bun'), 'inert Bun');
  writeFileSync(join(resources, 'agent.mjs'), 'inert replacement agent');
  const agentVersion = createHash('sha256').update('inert replacement agent').digest('hex');
  writeFileSync(join(resources, 'runtime.json'), JSON.stringify({ agentVersion, appVersion: '0.1.3', maintenanceProtocol: 1, target: 'darwin-arm64', executable: 'bun' }));
  writeFileSync(join(bundle, 'Contents/Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>0.1.3</string></dict></plist>');
  mkdirSync(join(f.stateRoot, 'agent'));
  const agentPath = join(f.stateRoot, 'agent/agent.json');
  writeFileSync(agentPath, JSON.stringify({ version: 1, policy: 'manual', policySource: 'person', paused: { reason: 'keep pause', at: '2026-10-12T00:00:00Z' }, installedBy: 'app', appPath, agentVersion, future: 'keep' }));
  const preserved = ['overrides.json', 'sync.json', 'history.json', 'credentials.json', 'device.json', 'agent/setups.json'].map(name => {
    const text = name === 'agent/setups.json' ? '{"version":1,"setups":[],"future":"keep trust"}' : `private original ${name}`;
    writeFileSync(join(f.stateRoot, name), text); return [name, text] as const;
  });
  const journalPath = join(f.stateRoot, 'agent/pending-update.json');
  writeFileSync(journalPath, JSON.stringify({ version: 1, phase: 'awaiting-health', appPath, bundlePath: bundle,
    fromVersion: '0.1.2', toVersion: '0.1.3', oldAgentVersion: 'a'.repeat(64), oldBundleHash: 'b'.repeat(64), backupPath: join(f.stateRoot, 'backups/old-app'), installerPid: null }));
  let foreground: Promise<number> | undefined;
  const controller = new AbortController(); t.after(() => controller.abort());
  const processes = Layer.succeed(Processes, { run: command => Effect.sync(() => {
    f.commands.push(command);
    if (command.cmd === '/usr/bin/xcode-select') return { code: 0, stdout: join(f.input.resources, 'developer'), stderr: '' };
    if (command.cmd === 'git') return { code: 1, stdout: '', stderr: 'inert checkout' };
    assert.equal(command.cmd, 'launchctl');
    if (command.args[0] === 'bootstrap') {
      assert.equal(existsSync(journalPath), true, 'registration alone must not clear pending');
      foreground = runDesktopEntry({ ...f.input, args: [], resources, processes, signal: controller.signal,
        stderr: f.input.stderr, stdout: text => assert.fail(`foreground emitted a helper record: ${text}`) });
    }
    return { code: 0, stdout: '', stderr: '' };
  }) });
  try {
    assert.equal(await runDesktopEntry({ ...startupInput(f), args: ['--startup', '--app', appPath], resources, processes }), 0, f.stderr.join(''));
    const result = startupResult(f);
    assert.equal(result.outcome, 'recovered'); assert.equal(result.stateRoot, f.stateRoot);
    assert.equal(result.maintenance.pending, true, 'startup records the journal observed before successful recovery');
    assert.equal(result.maintenance.phase, 'awaiting-health'); assert.equal(existsSync(journalPath), false);
    const after = JSON.parse(readFileSync(agentPath, 'utf8'));
    assert.equal(after.policy, 'manual'); assert.equal(after.policySource, 'person');
    assert.deepEqual(after.paused, { reason: 'keep pause', at: '2026-10-12T00:00:00Z' }); assert.equal(after.future, 'keep');
    for (const [name, bytes] of preserved) assert.equal(readFileSync(join(f.stateRoot, name), 'utf8'), bytes);
    assert.equal(f.probes(), 2, 'one startup probe plus the independent foreground agent probe');
    const connection = await connectAgent(f.paths, { client: 'app' });
    try { assert.equal(connection.hello.agentVersion, agentVersion); await connection.request({ command: 'shutdown' }); }
    finally { connection.close(); }
  } finally { controller.abort(); if (foreground) assert.equal(await foreground, 0); }
});

test('startup refuses an unsafe resolved root before setup reads or lifecycle', async t => {
  const f = fixture(t);
  assert.equal(await runDesktopEntry({ ...startupInput(f), probe: async () => ({ env: { HOME: f.home, NORTUSCC_STATE_DIR: 'relative-state' } }) }), 1);
  assert.deepEqual(f.stdout, []); assert.deepEqual(f.commands, []);
});

test('startup refuses an unsafe recorded checkout before service commands or state writes', async t => {
  const f = fixture(t);
  const unsafeRepo = join(f.home, 'unsafe\ncheckout');
  mkdirSync(join(unsafeRepo, '.git'), { recursive: true });
  const original = JSON.stringify({ version: 1, repo: unsafeRepo, files: {} });
  writeFileSync(join(f.stateRoot, 'state.json'), original);
  const code = await runDesktopEntry(startupInput(f));
  assert.equal(f.commands.some(c => c.cmd === 'launchctl'), false, 'unsafe setup cannot enter service registration');
  assert.equal(existsSync(join(f.stateRoot, 'agent')), false, 'unsafe setup cannot write lifecycle locks or metadata');
  assert.equal(existsSync(join(f.home, 'Library/LaunchAgents')), false, 'unsafe setup cannot write a service unit');
  assert.equal(readFileSync(join(f.stateRoot, 'state.json'), 'utf8'), original);
  assert.equal(code, 0);
  assert.deepEqual(startupResult(f), { stateRoot: f.stateRoot, setup: null, maintenance: null, outcome: 'setup_failed' });
  const records = startupRecords(f.stderr);
  assert.equal(records.some(r => r.phase === 'runtime_metadata' || r.phase === 'maintenance_state' || r.phase === 'lifecycle'), false);
});

test('the installed app service accepts late registration and advertises real runtime metadata and machine target choices to MCP', {skip:process.platform === 'win32', timeout:10000}, async t => {
  const f=fixture(t); const controller=new AbortController(); t.after(() => controller.abort());
  const resources=join(f.home,'Nortuscc.app/Contents/Resources/agent-runtime'); mkdirSync(resources,{recursive:true});
  writeFileSync(join(resources,'runtime.json'),JSON.stringify({agentVersion:'bundle-hash',appVersion:'0.1.6',target:'darwin-arm64'}));
  mkdirSync(join(f.stateRoot,'agent'),{recursive:true});
  writeFileSync(join(f.stateRoot,'agent/agent.json'),JSON.stringify({version:1,policy:'manual',policySource:'person',paused:null,installedBy:'app',agentVersion:'bundle-hash'}));
  writeFileSync(join(f.stateRoot,'overrides.json'),JSON.stringify({version:1,configTargets:['codex']}));
  const running=runDesktopEntry({...f.input,args:[],resources,signal:controller.signal});
  let conn: AgentConnection | undefined; const until=Date.now()+5000;
  while(!conn && Date.now()<until) {
    try {conn=await connectAgent(f.paths,{client:'mcp',runtimeId:'bundle-hash',timeoutMs:100});} catch {await new Promise(resolve=>setTimeout(resolve,10));}
  }
  try {
    assert.ok(conn,f.stderr.join('')); assert.deepEqual(conn.hello.app,{ownership:'app',version:'0.1.6',runtimeId:'bundle-hash'});
    assert.equal(conn.hello.operations?.available,false); assert.equal(conn.hello.operationsProtocol,1);
    const pending=await conn.request<any>({command:'operation',operation:'getContext',input:{}});
    assert.equal(pending.capabilities.applyChange.available,false);
    writeFileSync(join(f.stateRoot,'agent/agent.json'),JSON.stringify({version:1,policy:'manual',policySource:'person',paused:null,installedBy:'app',agentVersion:'bundle-hash',appPath:f.input.args[2]}));
    const context=await conn.request<any>({command:'operation',operation:'getContext',input:{}});
    assert.deepEqual(context.targets,['codex']); assert.equal(context.policy,'manual'); assert.equal(context.capabilities.applyChange.available,true);
    assert.deepEqual(context.profiles,{state:'unavailable',reason:'Profile discovery is not available in the machine reconciliation workflow.'});
    assert.equal(context.account.state,'unavailable');
    writeFileSync(join(f.stateRoot,'agent/agent.json'),JSON.stringify({version:1,policy:'manual',policySource:'person',paused:null,installedBy:'cli',agentVersion:'bundle-hash'}));
    await assert.rejects(conn.request({command:'operation',operation:'inspect',input:{}}),error => error instanceof AgentError && error.code==='APP_UNAVAILABLE');
    assert.ok(f.commands.every(command=>command.cmd!=='launchctl'));
  } finally {conn?.close();controller.abort();assert.equal(await running,0);}
});

test('a corrupt followed store leaves the agent running with the setup source unavailable', { timeout: 10000 }, async t => {
  const f = fixture(t);
  mkdirSync(join(f.stateRoot, 'agent'), { recursive: true });
  const path = join(f.stateRoot, 'agent/followed.json');
  writeFileSync(path, '{invalid');
  writeFileSync(join(f.stateRoot, 'agent/setups.json'), JSON.stringify({ version: 1, setups: [
    { setupId: null, repoUrl: null, checkout: f.repo, trustedAt: '2026-10-16T00:00:00Z' },
  ] }));
  const controller = new AbortController(); t.after(() => controller.abort());
  const running = runDesktopEntry({ ...f.input, args: [], signal: controller.signal });
  let conn: AgentConnection | undefined;
  const until = Date.now() + 5000;
  try {
    while (!conn && Date.now() < until) {
      try { conn = await connectAgent(f.paths, { client: 'app', timeoutMs: 100 }); }
      catch { await new Promise(done => setTimeout(done, 10)); }
    }
    assert.ok(conn, f.stderr.join(''));
    let status: { error?: string } | undefined;
    while (!status && Date.now() < until) {
      try { status = await conn.request({ command: 'status' }); }
      catch (error) { if (!(error instanceof AgentError && error.code === 'NO_REPORT')) throw error; await new Promise(done => setTimeout(done, 10)); }
    }
    assert.equal(status?.error, 'REVISION_UNAVAILABLE');
    await assert.rejects(conn.request({ command: 'operation', operation: 'setupReview', input: { setupId: 'local', refetch: true, limit: 100 } }),
      error => error instanceof AgentError && error.code === 'INSPECT_FAILED');
    assert.equal(readFileSync(path, 'utf8'), '{invalid');
    assert.ok(f.commands.every(c => c.cmd === 'git' && c.args.includes('get-url')), 'only the setup review trust check reads the CLI origin');
    await conn.request({ command: 'shutdown' });
  } finally { conn?.close(); controller.abort(); await running; }
  assert.equal(await running, 0);
});

test('a foreground agent follows its private source after the CLI checkout disappears', { timeout: 10000 }, async t => {
  const f = fixture(t);
  rmSync(f.repo, { recursive: true, force: true });
  mkdirSync(join(f.stateRoot, 'agent'), { recursive: true });
  writeFileSync(join(f.stateRoot, 'agent/followed.json'), JSON.stringify({ version: 1, followed: { repoUrl: 'https://github.com/example/followed.git', profile: 'default', setupId: null } }));
  const controller = new AbortController(); t.after(() => controller.abort());
  const running = runDesktopEntry({ ...f.input, args: [], signal: controller.signal });
  let conn: AgentConnection | undefined;
  const until = Date.now() + 5000;
  while (!conn && Date.now() < until) {
    try { conn = await connectAgent(f.paths, { client: 'app', timeoutMs: 100 }); }
    catch { await new Promise(done => setTimeout(done, 10)); }
  }
  assert.ok(conn, f.stderr.join(''));
  try {
    let status: { error?: string } | undefined;
    while (!status && Date.now() < until) {
      try { status = await conn.request({ command: 'status' }); }
      catch (error) { if (!(error instanceof AgentError && error.code === 'NO_REPORT')) throw error; await new Promise(done => setTimeout(done, 10)); }
    }
    assert.equal(status?.error, 'REVISION_UNAVAILABLE');
    assert.ok(f.commands.some(c => c.cmd === 'git' && c.args.includes('ls-remote')), 'the selected private source checks access');
    assert.equal(f.commands.some(c => c.cwd === f.repo), false);
    await conn.request({ command: 'shutdown' });
    assert.equal(await running, 0);
  } finally { conn.close(); controller.abort(); }
});
