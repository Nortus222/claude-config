import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect, Exit, Layer } from 'effect';
import { nodeFs, Processes, type Command } from '@nortuscc/machine';
import {
  installService, renderLaunchAgent, renderScheduledTask, renderSystemdUnit, restartService, ServiceFailed, serviceInstalled,
  uninstallService, unitPath, type ServiceProgram, type ServiceTarget,
} from '../src/index.ts';

const program: ServiceProgram = {
  argv: ['/opt/node/bin/node', '/home/me/checkout/bin/nortuscc.mjs', 'agent', 'run'],
  env: { PATH: '/usr/bin:/bin' },
  workingDirectory: '/home/me/checkout',
  logPath: '/home/me/.config/nortuscc/agent/agent.log',
};
const changed: ServiceProgram = { ...program, argv: ['/opt/node2/bin/node', ...program.argv.slice(1)] };

const targetFor = (platform: ServiceTarget['platform']): ServiceTarget => {
  const home = mkdtempSync(join(tmpdir(), 'service-'));
  return { platform, home, uid: 501, user: 'me', stateRoot: join(home, '.config', 'nortuscc') };
};

// Records every argv and answers its exit code from `codes` (keyed by the joined argv), else 0. An
// array answers successive calls in turn, its last code repeating. A failure writes `refused` to stderr.
const fakeProcesses = (codes: Readonly<Record<string, number | readonly number[]>> = {}) => {
  const calls: string[] = [];
  const commands: Command[] = [];
  const layer = Layer.succeed(Processes, {
    run: (command) => Effect.sync(() => {
      const line = [command.cmd, ...command.args].join(' ');
      const answer = codes[line] ?? 0;
      const code = typeof answer === 'number' ? answer : answer[Math.min(calls.filter((c) => c === line).length, answer.length - 1)]!;
      calls.push(line);
      commands.push(command);
      return { code, stdout: '', stderr: code === 0 ? '' : '  refused\n' };
    }),
  });
  return { calls, commands, layer };
};

const fast = { retryDelayMs: 0 };

const run = <A, E>(effect: Effect.Effect<A, E, any>, processes: Layer.Layer<Processes>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(Layer.merge(nodeFs, processes))) as Effect.Effect<A, E>);

const ok = async <A, E>(effect: Effect.Effect<A, E, any>, processes: Layer.Layer<Processes>) => {
  const exit = await run(effect, processes);
  if (Exit.isFailure(exit)) assert.fail(String(exit.cause));
  return exit.value;
};

const utf16 = (path: string) => {
  const bytes = readFileSync(path);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], 'a UTF-16LE byte-order mark');
  return bytes.subarray(2).toString('utf16le');
};

const D = 'gui/501';
const L = 'com.nortuscc.agent';

test('unitPath is per OS, under the default directory unless one is given', () => {
  const t = targetFor('darwin');
  assert.equal(unitPath(t), join(t.home, 'Library', 'LaunchAgents', `${L}.plist`));
  assert.equal(unitPath({ ...t, label: 'test.agent', unitDir: '/u' }), join('/u', 'test.agent.plist'));
  assert.equal(unitPath({ ...t, platform: 'linux' }), join(t.home, '.config', 'systemd', 'user', 'nortuscc-agent.service'));
  assert.equal(unitPath({ ...t, platform: 'win32' }), join(t.stateRoot, 'agent', 'nortuscc-agent.xml'));
});

test('darwin install writes the plist and bootstraps it', async () => {
  const t = targetFor('darwin');
  const p = fakeProcesses();
  await ok(installService(t, program), p.layer);
  const P = unitPath(t);
  assert.equal(readFileSync(P, 'utf8'), renderLaunchAgent(L, program));
  assert.deepEqual(p.calls, [`launchctl bootout ${D}/${L}`, `launchctl bootstrap ${D} ${P}`]);
  assert.equal(await ok(serviceInstalled(t), p.layer), true);
});

test('darwin install succeeds when bootout finds nothing loaded, and fails naming bootstrap and its stderr after 5 attempts', async () => {
  const t = targetFor('darwin');
  const P = unitPath(t);
  await ok(installService(t, program), fakeProcesses({ [`launchctl bootout ${D}/${L}`]: 3 }).layer);
  const p = fakeProcesses({ [`launchctl bootstrap ${D} ${P}`]: 5 });
  const error = await ok(Effect.flip(installService(t, program, fast)), p.layer);
  assert.ok(error instanceof ServiceFailed);
  assert.match(error.command, /^launchctl bootstrap/);
  assert.equal(error.code, 5);
  assert.equal(error.reason, 'refused');
  assert.equal(p.calls.filter((c) => c.startsWith('launchctl bootstrap')).length, 5);
});

// bootout returns before the old job is gone, so bootstrap can fail (exit 5 or 37) for a moment.
test('darwin install retries a bootstrap that fails while the old job tears down', async () => {
  const t = targetFor('darwin');
  const P = unitPath(t);
  const p = fakeProcesses({ [`launchctl bootstrap ${D} ${P}`]: [37, 5, 0] });
  await ok(installService(t, program, fast), p.layer);
  assert.deepEqual(p.calls, [`launchctl bootout ${D}/${L}`, ...Array(3).fill(`launchctl bootstrap ${D} ${P}`)]);
});

test('service commands capture stderr, so an ignored failure prints nothing', async () => {
  const t = targetFor('darwin');
  const p = fakeProcesses({ [`launchctl bootout ${D}/${L}`]: 3 });
  await ok(installService(t, program), p.layer);
  assert.ok(p.commands.every((c) => c.output === 'capture' && c.stderr === 'capture'), JSON.stringify(p.commands));
});

test('a failure with empty stderr reads as a non-zero exit', async () => {
  const t = targetFor('linux');
  const silent = Layer.succeed(Processes, { run: () => Effect.succeed({ code: 1, stdout: '', stderr: ' \n' }) });
  const error = await ok(Effect.flip(installService(t, program)), silent);
  assert.equal(error.reason, 'non-zero exit');
});

test('linux install writes the unit, reloads, enables and restarts it', async () => {
  const t = targetFor('linux');
  const p = fakeProcesses();
  await ok(installService(t, program), p.layer);
  assert.equal(readFileSync(unitPath(t), 'utf8'), renderSystemdUnit(program));
  assert.deepEqual(p.calls, [
    'systemctl --user daemon-reload',
    'systemctl --user enable nortuscc-agent.service',
    'systemctl --user restart nortuscc-agent.service',
  ]);
});

test('linux install with linger enables lingering first', async () => {
  const t = targetFor('linux');
  const p = fakeProcesses();
  await ok(installService(t, program, { linger: true }), p.layer);
  assert.equal(p.calls[0], 'loginctl enable-linger me');
  assert.equal(p.calls.length, 4);
});

// IgnoreNew makes /Run a no-op while an old instance runs, so the old one is ended first.
test('win32 install writes the task XML as UTF-16LE, ends any running task, then creates and runs it', async () => {
  const t = targetFor('win32');
  const p = fakeProcesses({ 'schtasks /End /TN nortuscc-agent': 1 });
  await ok(installService(t, program), p.layer);
  const P = unitPath(t);
  assert.equal(utf16(P), renderScheduledTask(program, 'me'));
  assert.deepEqual(p.calls, [
    'schtasks /End /TN nortuscc-agent', `schtasks /Create /TN nortuscc-agent /XML ${P} /F`, 'schtasks /Run /TN nortuscc-agent',
  ]);
});

test('darwin uninstall boots the agent out and removes the plist', async () => {
  const t = targetFor('darwin');
  await ok(installService(t, program), fakeProcesses().layer);
  const p = fakeProcesses({ [`launchctl bootout ${D}/${L}`]: 3 });
  await ok(uninstallService(t), p.layer);
  assert.deepEqual(p.calls, [`launchctl bootout ${D}/${L}`]);
  assert.equal(existsSync(unitPath(t)), false);
  assert.equal(await ok(serviceInstalled(t), p.layer), false);
});

test('linux uninstall disables the unit, removes it and reloads, even with no user bus', async () => {
  const t = targetFor('linux');
  await ok(installService(t, program), fakeProcesses().layer);
  const p = fakeProcesses({ 'systemctl --user disable --now nortuscc-agent.service': 1, 'systemctl --user daemon-reload': 1 });
  await ok(uninstallService(t), p.layer);
  assert.deepEqual(p.calls, ['systemctl --user disable --now nortuscc-agent.service', 'systemctl --user daemon-reload']);
  assert.equal(existsSync(unitPath(t)), false);
});

test('win32 uninstall ends and deletes the task, then removes the XML', async () => {
  const t = targetFor('win32');
  await ok(installService(t, program), fakeProcesses().layer);
  const p = fakeProcesses({ 'schtasks /End /TN nortuscc-agent': 1, 'schtasks /Delete /TN nortuscc-agent /F': 1 });
  await ok(uninstallService(t), p.layer);
  assert.deepEqual(p.calls, ['schtasks /End /TN nortuscc-agent', 'schtasks /Delete /TN nortuscc-agent /F']);
  assert.equal(existsSync(unitPath(t)), false);
});

test('darwin restart kickstarts an unchanged agent, and re-bootstraps a changed one', async () => {
  const t = targetFor('darwin');
  const P = unitPath(t);
  await ok(installService(t, program), fakeProcesses().layer);
  const same = fakeProcesses();
  await ok(restartService(t, program), same.layer);
  assert.deepEqual(same.calls, [`launchctl kickstart -k ${D}/${L}`]);
  const different = fakeProcesses({ [`launchctl bootstrap ${D} ${P}`]: [5, 0] });
  await ok(restartService(t, changed, fast), different.layer);
  assert.deepEqual(different.calls, [`launchctl bootout ${D}/${L}`, `launchctl bootstrap ${D} ${P}`, `launchctl bootstrap ${D} ${P}`]);
  assert.equal(readFileSync(P, 'utf8'), renderLaunchAgent(L, changed));
});

test('linux restart only restarts an unchanged unit, and reloads a changed one first', async () => {
  const t = targetFor('linux');
  await ok(installService(t, program), fakeProcesses().layer);
  const same = fakeProcesses();
  await ok(restartService(t, program), same.layer);
  assert.deepEqual(same.calls, ['systemctl --user restart nortuscc-agent.service']);
  const different = fakeProcesses();
  await ok(restartService(t, changed), different.layer);
  assert.deepEqual(different.calls, ['systemctl --user daemon-reload', 'systemctl --user restart nortuscc-agent.service']);
  assert.equal(readFileSync(unitPath(t), 'utf8'), renderSystemdUnit(changed));
});

test('win32 restart ends and runs an unchanged task, and re-creates a changed one after ending it', async () => {
  const t = targetFor('win32');
  const P = unitPath(t);
  await ok(installService(t, program), fakeProcesses().layer);
  const same = fakeProcesses({ 'schtasks /End /TN nortuscc-agent': 1 });
  await ok(restartService(t, program), same.layer);
  assert.deepEqual(same.calls, ['schtasks /End /TN nortuscc-agent', 'schtasks /Run /TN nortuscc-agent']);
  const different = fakeProcesses();
  await ok(restartService(t, changed), different.layer);
  assert.deepEqual(different.calls, [
    'schtasks /End /TN nortuscc-agent', `schtasks /Create /TN nortuscc-agent /XML ${P} /F`, 'schtasks /Run /TN nortuscc-agent',
  ]);
  assert.equal(utf16(P), renderScheduledTask(changed, 'me'));
});
