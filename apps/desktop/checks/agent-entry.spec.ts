import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Effect, Layer } from 'effect';
import { nodeProcesses, Processes, type Command, type MachinePathsValue } from '@nortuscc/machine';
import { AgentError, connectAgent, type AgentConnection } from '../../../src/agent-client.ts';
import { runDesktopEntry } from '../agent/main.ts';

const fixture = (t: { after: (f: () => void) => void }) => {
  const home = mkdtempSync(join(tmpdir(), 'nae-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const resources = join(home, 'resources');
  const repo = join(home, 'repo');
  const stateRoot = join(home, 'state');
  mkdirSync(resources);
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(stateRoot);
  writeFileSync(join(resources, 'runtime.json'), JSON.stringify({ agentVersion: 'bundle-hash' }));
  writeFileSync(join(stateRoot, 'state.json'), JSON.stringify({ repo }));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: Command[] = [];
  const processes = Layer.succeed(Processes, { run: (command) => Effect.sync(() => {
    commands.push(command);
    if (command.cmd === 'launchctl') return { code: 0, stdout: '', stderr: '' };
    assert.equal(command.cmd, 'git');
    return { code: 1, stdout: '', stderr: 'fixture has no commit' };
  }) });
  let probes = 0;
  const input = {
    args: ['--ensure', '--app', join(home, 'Nortuscc.app/Contents/MacOS/Nortuscc')], resources,
    env: { HOME: home, SHELL: '/fake/shell', PATH: '/inherited', NORTUSCC_STATE_DIR: stateRoot },
    platform: 'darwin' as const, uid: 501, user: 'fixture', processes,
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
    env: { HOME: f.home, PATH: '/login/bin', NORTUSCC_STATE_DIR: f.stateRoot, ...handoff },
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
    env: { HOME: f.home, PATH: '/login/bin', NORTUSCC_STATE_DIR: f.stateRoot, ...handoff },
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
