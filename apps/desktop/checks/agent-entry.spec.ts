import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Effect, Layer } from 'effect';
import { nodeProcesses, Processes, type Command, type MachinePathsValue } from '@nortuscc/machine';
import { HostedFailure, HostedTransport } from '@nortuscc/hosted-client';
import { AgentError, connectAgent, type AgentConnection } from '../../../src/agent-client.ts';
import { runDesktopEntry } from '../agent/main.ts';

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
  writeFileSync(join(stateRoot, 'state.json'), JSON.stringify({ repo }));
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
    hostedDependencies: { keychain: { read: () => Effect.succeed(undefined), write: () => Effect.void, remove: () => Effect.void },
      transport: Layer.succeed(HostedTransport, { request: () => Effect.fail(new HostedFailure({ code: 'network' })) }) },
    probe: async () => { probes++; return { env: { HOME: home, PATH: '/login/bin', NORTUSCC_STATE_DIR: stateRoot } }; },
    stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line),
  };
  const paths: MachinePathsValue = { repo, stateRoot, backups: join(stateRoot, 'backups'), claude: join(home, '.claude'), codex: join(home, '.codex'), codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents/skills') };
  return { input, home, repo, stateRoot, paths, stdout, stderr, commands, probes: () => probes };
};

test('the ensure helper resolves recorded checkout from login environment and prints exactly one result', async (t) => {
  const f = fixture(t);
  assert.equal(await runDesktopEntry(f.input), 0);
  assert.deepEqual(f.stdout, [JSON.stringify({ stateRoot: f.stateRoot }) + '\n']);
  assert.deepEqual(f.stderr, []);
  assert.equal(f.probes(), 1);
  assert.ok(f.commands.some((c) => c.cmd === 'launchctl'));
  assert.equal(JSON.parse(readFileSync(join(f.stateRoot, 'agent/agent.json'), 'utf8')).agentVersion, 'bundle-hash');
  assert.ok(readFileSync(join(f.home, 'Library/LaunchAgents/com.nortuscc.agent.plist'), 'utf8').includes('/login/bin'));
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
