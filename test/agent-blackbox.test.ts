import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BIN, cliEnv, machine, pushUpstream, readJson, REPO, runCli, writeFakeBin, type Call, type Machine } from './support/cli.ts';

// `nortuscc agent` against fake service managers: a real launchctl, systemctl or loginctl never runs.
const skip = process.platform === 'win32' ? 'the login service is registered by schtasks on Windows' : false;
const linux = process.platform === 'linux';
const TOOLS = linux ? ['systemctl', 'loginctl'] : ['launchctl'];

const serviceLog = (m: Machine) => join(m.home, 'service.log');

// A machine whose service tools are fakes that log their argv, proven to shadow the real ones.
// `failing` makes every call exit 5 with a reason on stderr.
function serviceMachine(failing = false): Machine {
  const m = machine();
  for (const tool of TOOLS) {
    writeFakeBin(m.bin, tool, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(serviceLog(m))}, JSON.stringify({ cmd: ${JSON.stringify(tool)}, args: process.argv.slice(2) }) + '\\n');
${failing ? "process.stderr.write('refused\\n'); process.exit(5);" : ''}
`);
    const found = execFileSync('which', [tool], { env: cliEnv(m), encoding: 'utf8' }).trim();
    assert.equal(found, join(m.bin, tool), `${tool} must resolve to the fake`);
  }
  return m;
}

const serviceCalls = (m: Machine): Call[] =>
  existsSync(serviceLog(m)) ? readFileSync(serviceLog(m), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Call) : [];

const unit = (m: Machine) =>
  linux ? join(m.home, '.config', 'systemd', 'user', 'nortuscc-agent.service') : join(m.home, 'Library', 'LaunchAgents', 'com.nortuscc.agent.plist');

const agentDir = (m: Machine) => join(m.state, 'agent');
const agentJson = (m: Machine) => readJson(join(agentDir(m), 'agent.json'));
const ownSetups = (m: Machine) => (readJson(join(agentDir(m), 'setups.json')).setups as Array<{ setupId: string | null; checkout: string }>)
  .filter((s) => s.setupId === null);

// The registration argv: systemd enables the unit; launchd bootstraps it from its path.
const registered = (m: Machine) =>
  linux
    ? serviceCalls(m).some((c) => c.cmd === 'systemctl' && c.args.join(' ') === '--user enable nortuscc-agent.service')
    : serviceCalls(m).some((c) => c.cmd === 'launchctl' && c.args[0] === 'bootstrap' && c.args[2] === unit(m));

test('agent install writes the unit, registers it, trusts the checkout and records the CLI as installer', { skip }, async () => {
  const m = serviceMachine();
  const result = await runCli(m, ['agent', 'install']);
  assert.equal(result.code, 0, result.stderr);
  const text = readFileSync(unit(m), 'utf8');
  assert.ok(text.includes(process.execPath), 'names node');
  assert.ok(text.includes(join(REPO, 'bin', 'nortuscc.mjs')), 'names the launcher');
  assert.ok(text.includes('NORTUSCC_REPO_DIR') && text.includes(m.repo), 'passes the checkout through');
  assert.ok(!text.includes('NORTUSCC_TEST_'), 'leaves test-only variables out');
  assert.ok(registered(m), JSON.stringify(serviceCalls(m)));
  assert.equal(agentJson(m).installedBy, 'cli');
  assert.equal(typeof agentJson(m).agentVersion, 'string');
  const own = ownSetups(m);
  assert.equal(own.length, 1);
  assert.equal(own[0]!.checkout, m.repo);
  assert.match(result.stdout, /^trusted: /m);
  assert.match(result.stdout, new RegExp(`agent installed: ${unit(m).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stdout, /log: .*agent\.log/);
});

test('agent install reports a failed service command and exits 1', { skip }, async () => {
  const m = serviceMachine(true);
  const result = await runCli(m, ['agent', 'install']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^nortuscc: (launchctl|systemctl) .* exited 5: refused$/m);
  assert.equal(existsSync(join(agentDir(m), 'agent.json')) ? agentJson(m).installedBy : undefined, undefined);
});

test('agent install twice keeps one own setup and rewrites the unit', { skip }, async () => {
  const m = serviceMachine();
  assert.equal((await runCli(m, ['agent', 'install'])).code, 0);
  writeFileSync(unit(m), 'stale');
  const again = await runCli(m, ['agent', 'install']);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(ownSetups(m).length, 1);
  assert.notEqual(readFileSync(unit(m), 'utf8'), 'stale');
});

test('agent install and uninstall leave an app-installed agent to the app', { skip }, async () => {
  const m = serviceMachine();
  mkdirSync(agentDir(m), { recursive: true });
  writeFileSync(join(agentDir(m), 'agent.json'), JSON.stringify({ version: 1, policy: 'notify', policySource: 'default', paused: null, installedBy: 'app' }));
  for (const verb of ['install', 'uninstall']) {
    const result = await runCli(m, ['agent', verb]);
    assert.equal(result.code, 1, verb);
    assert.match(result.stderr, /the desktop app manages the agent on this machine; manage it from the app\./, verb);
  }
  assert.deepEqual(serviceCalls(m), []);
  assert.equal(existsSync(unit(m)), false);
  assert.equal(agentJson(m).installedBy, 'app');
});

test('agent install --linger is for Linux only', { skip }, async () => {
  const m = serviceMachine();
  const result = await runCli(m, ['agent', 'install', '--linger']);
  if (linux) {
    assert.equal(result.code, 0, result.stderr);
    assert.ok(serviceCalls(m).some((c) => c.cmd === 'loginctl' && c.args[0] === 'enable-linger'));
  } else {
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--linger is for Linux only/);
    assert.deepEqual(serviceCalls(m), []);
    assert.equal(existsSync(unit(m)), false);
  }
});

test('agent install refuses an unknown flag and writes nothing', { skip }, async () => {
  const m = serviceMachine();
  const result = await runCli(m, ['agent', 'install', '--bogus']);
  assert.equal(result.code, 2);
  assert.deepEqual(serviceCalls(m), []);
  assert.equal(existsSync(unit(m)), false);
  assert.equal(existsSync(join(agentDir(m), 'agent.json')), false);
});

test('agent with no or an unknown subcommand prints usage and exits 2', { skip }, async () => {
  const m = serviceMachine();
  for (const args of [['agent'], ['agent', 'bogus']]) {
    const result = await runCli(m, args);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, /agent install/, args.join(' '));
  }
});

test('agent uninstall removes the unit and the socket and token, keeping History', { skip }, async () => {
  const m = serviceMachine();
  assert.equal((await runCli(m, ['agent', 'install'])).code, 0);
  const historyDir = join(m.state, 'history');
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(join(historyDir, 'kept.jsonl'), '{}\n');
  writeFileSync(join(agentDir(m), 'agent.sock'), '');
  writeFileSync(join(agentDir(m), 'agent.token'), 'secret');
  const result = await runCli(m, ['agent', 'uninstall']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /agent uninstalled; History, decisions, backups and trusted setups are kept/);
  assert.equal(existsSync(unit(m)), false);
  assert.equal(existsSync(join(agentDir(m), 'agent.sock')), false);
  assert.equal(existsSync(join(agentDir(m), 'agent.token')), false);
  assert.equal(agentJson(m).installedBy, undefined);
  assert.equal(agentJson(m).agentVersion, undefined);
  assert.equal(readFileSync(join(historyDir, 'kept.jsonl'), 'utf8'), '{}\n');
  assert.equal(ownSetups(m).length, 1);
});

test('agent uninstall with nothing installed exits 0', { skip }, async () => {
  const m = serviceMachine();
  const result = await runCli(m, ['agent', 'uninstall']);
  assert.equal(result.code, 0, result.stderr);
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (check()) return true;
  return check();
}

test('agent run holds the agent lock, refuses a second agent and stops cleanly on SIGTERM', { skip }, async () => {
  const m = serviceMachine();
  const lock = join(agentDir(m), 'agent.lock');
  const child = spawn(process.execPath, [BIN, 'agent', 'run'], { env: cliEnv(m), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    assert.ok(await until(() => existsSync(lock), 15_000), `agent.lock never appeared: ${stderr}`);
    assert.match(stderr, new RegExp(`nortuscc agent: running from .* \\(pid ${child.pid}\\)`));

    const second = await runCli(m, ['agent', 'run']);
    assert.equal(second.code, 1);
    assert.match(second.stderr, new RegExp(`another agent \\(pid ${child.pid}\\) is running`));

    child.kill('SIGTERM');
    const code = await Promise.race([exited, wait(15_000).then(() => 'timeout' as const)]);
    assert.equal(code, 0, stderr);
    assert.equal(existsSync(lock), false);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

// The restart argv: launchd kickstarts the unchanged unit; systemd restarts it.
const restarted = (m: Machine) =>
  linux
    ? serviceCalls(m).some((c) => c.cmd === 'systemctl' && c.args.join(' ') === '--user restart nortuscc-agent.service')
    : serviceCalls(m).some((c) => c.cmd === 'launchctl' && c.args.join(' ') === `kickstart -k gui/${process.getuid!()}/com.nortuscc.agent`);

test('sync restarts a CLI-installed agent after the checkout moves', { skip }, async () => {
  const m = serviceMachine();
  assert.equal((await runCli(m, ['agent', 'install'])).code, 0);
  assert.equal(restarted(m), false);
  pushUpstream(m, { 'claude/CLAUDE.md': '# moved\n' });
  const result = await runCli(m, ['sync', '--yes']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(restarted(m), JSON.stringify(serviceCalls(m)));
  assert.match(result.stdout, /^agent restarted on [0-9a-f]{7}$/m);
  assert.equal(agentJson(m).agentVersion, execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
});

test('sync with no agent installed runs no service command', { skip }, async () => {
  const m = serviceMachine();
  pushUpstream(m, { 'claude/CLAUDE.md': '# moved\n' });
  const result = await runCli(m, ['sync', '--yes']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(serviceCalls(m), []);
  assert.doesNotMatch(result.stdout, /agent restarted/);
});

test('sync that leaves the checkout where it was does not restart the agent', { skip }, async () => {
  const m = serviceMachine();
  assert.equal((await runCli(m, ['agent', 'install'])).code, 0);
  const before = serviceCalls(m).length;
  const result = await runCli(m, ['sync', '--yes']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(serviceCalls(m).length, before);
});

test('a failed restart warns and never fails the sync', { skip }, async () => {
  const m = serviceMachine();
  assert.equal((await runCli(m, ['agent', 'install'])).code, 0);
  for (const tool of TOOLS) writeFakeBin(m.bin, tool, "#!/usr/bin/env node\nprocess.stderr.write('refused\\n'); process.exit(5);\n");
  pushUpstream(m, { 'claude/CLAUDE.md': '# moved\n' });
  const result = await runCli(m, ['sync', '--yes']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /^nortuscc: .*exited 5: refused/m);
  assert.doesNotMatch(result.stdout, /agent restarted/);
});
