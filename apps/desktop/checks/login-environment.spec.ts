import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { nodeProcesses } from '@nortuscc/machine';
import { ghStatus } from '../../../packages/agent/src/author/gh.ts';
import { MACOS_TOOL_DIRECTORIES, missingTools, probeLoginEnvironment, withToolDirectories } from '../agent/login-environment.ts';
import type { StartupPhase, StartupStatus } from '../agent/startup-diagnostics.ts';
import { assertExited, assertReaped } from './support/processes.ts';

const dir = mkdtempSync(join(tmpdir(), 'nortuscc-login-env-'));
const unixShell = { skip: process.platform === 'win32' ? 'requires POSIX shell scripts and process groups' : false };
test.after(() => rmSync(dir, { recursive: true, force: true }));
const script = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

test('cancelling a held login capture joins its detached shell and runtime before rejecting', { ...unixShell, timeout: 10000 }, async () => {
  for (const stage of ['shell', 'runtime']) {
    const owned = mkdtempSync(join(dir, 'cancel-'));
    const shellPid = join(owned, 'shell.pid');
    const runtimePid = join(owned, 'runtime.pid');
    const shell = script(`cancel-${stage}-shell`, `echo $$ > '${shellPid}'\n${stage === 'shell' ? 'exec /bin/sleep 30' : 'exec /bin/sh -c "$2"'}`);
    const runtime = script(`cancel-${stage}-runtime`, `echo $$ > '${runtimePid}'\nexec /bin/sleep 30`);
    const controller = new AbortController();
    const events: Array<[StartupPhase, StartupStatus]> = [];
    const input = { env: { HOME: owned, SHELL: shell, PATH: '/inherited', API_TOKEN: 'private-fixture-token' }, runtime,
      timeoutMs: 1000, signal: controller.signal, onProgress: (phase: StartupPhase, status: StartupStatus) => events.push([phase, status]) };
    const running = probeLoginEnvironment(input);
    const rejected = assert.rejects(running, { name: 'AbortError' });
    const pids: number[] = [];
    try {
      const held = stage === 'shell' ? shellPid : runtimePid;
      const heldPhase = stage === 'shell' ? 'shell_ready' : 'environment_ready';
      const phaseStarted = () => events.some(([phase, status]) => phase === heldPhase && status === 'started');
      const until = Date.now() + 3000;
      // The PID file can precede delivery of the shell's readiness marker to the parent.
      while ((!readable(held) || !phaseStarted()) && Date.now() < until) await new Promise(done => setTimeout(done, 10));
      assert.ok(readable(held), 'owned probe reaches the held process');
      assert.ok(phaseStarted(), 'probe observes the held phase before cancellation');
      pids.push(Number(readFileSync(shellPid, 'utf8')));
      if (stage === 'runtime') pids.push(Number(readFileSync(runtimePid, 'utf8')));
      controller.abort();
      await rejected;
      assertReaped(pids[0]!, 'the login shell was reaped before probe return');
      if (stage === 'runtime') assertExited(pids[1]!, 'the capture runtime exited before probe return');
      assert.deepEqual(events.filter(([phase]) => phase === 'probe_cleanup'), [['probe_cleanup', 'started'], ['probe_cleanup', 'completed']]);
      assert.ok(events.some(([phase, status]) => phase === heldPhase && status === 'cancelled'));
      assert.equal(JSON.stringify(events).includes('private-fixture-token'), false);
    } finally {
      controller.abort();
      await running.catch(() => {});
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  }
});

const readable = (path: string) => { try { return readFileSync(path, 'utf8').trim() !== ''; } catch { return false; } };

test('reads the login environment despite login banners', unixShell, async () => {
  // Runs the probe's own script ($2) after an rc file that sets PATH and a secret an MCP server needs.
  const shell = script('noisy', 'echo "Welcome to your shell"\nPATH=/opt/tools/bin:/usr/bin\nAPI_TOKEN=secret\nMULTI="a\nb"\nexport PATH API_TOKEN MULTI\n/bin/sh -c "$2"\necho "bye"');
  const result = await probeLoginEnvironment({ env: { SHELL: shell, PATH: '/inherited' } });
  assert.equal(result.error, undefined);
  assert.equal(result.env.PATH, '/opt/tools/bin:/usr/bin');
  assert.equal(result.env.API_TOKEN, 'secret');
  assert.equal(result.env.MULTI, 'a\nb');
});

test('a runtime path with a space and a quote is quoted for the shell', unixShell, async () => {
  const odd = join(dir, "a b's");
  mkdirSync(odd);
  const runtime = join(odd, 'node');
  symlinkSync(process.execPath, runtime);
  const shell = script('quoted', 'QUOTED_OK=yes\nexport QUOTED_OK\n/bin/sh -c "$2"');
  const result = await probeLoginEnvironment({ env: { SHELL: shell, PATH: '/inherited' }, runtime });
  assert.equal(result.error, undefined);
  assert.equal(result.env.QUOTED_OK, 'yes');
});

test('a hanging shell times out and falls back to the inherited PATH', unixShell, async () => {
  const shell = script('hang', '/bin/sleep 30');
  const started = Date.now();
  const result = await probeLoginEnvironment({ env: { SHELL: shell, PATH: '/inherited' }, timeoutMs: 200 });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.env.PATH, '/inherited');
  assert.match(result.error!, /timed out/);
});

test('probe timing distinguishes shell readiness from a stalled runtime and joins cleanup once', unixShell, async () => {
  const shell = script('timed-shell', 'exec /bin/sh -c "$2"');
  const runtime = script('timed-runtime', '/bin/sleep 30');
  const events: Array<[StartupPhase, StartupStatus]> = [];
  const result = await probeLoginEnvironment({ env: { SHELL: shell, PATH: '/inherited' }, runtime, timeoutMs: 1000,
    onProgress: (phase, status) => events.push([phase, status]) });
  assert.match(result.error!, /timed out/);
  assert.equal(result.env.PATH, '/inherited');
  const until = Date.now() + 1000;
  while (!events.some(([phase, status]) => phase === 'probe_cleanup' && status === 'completed') && Date.now() < until) {
    await new Promise(done => setTimeout(done, 10));
  }
  assert.deepEqual(events.filter(([phase]) => phase === 'shell_ready'), [['shell_ready', 'started'], ['shell_ready', 'completed']]);
  assert.deepEqual(events.filter(([phase]) => phase === 'environment_ready'), [['environment_ready', 'started'], ['environment_ready', 'timed_out']]);
  assert.deepEqual(events.filter(([phase]) => phase === 'probe_cleanup'), [['probe_cleanup', 'started'], ['probe_cleanup', 'completed']]);
});

test('a background process holding stdout does not delay the PATH or outlive the probe', unixShell, async () => {
  // An rc file that starts a background job leaves stdout open after the probe script prints.
  const pidFile = join(dir, 'background.pid');
  const shell = script('background', `/bin/sleep 30 &\necho $! > ${pidFile}\nPATH=/opt/tools/bin:/usr/bin\nexport PATH\n/bin/sh -c "$2"`);
  const started = Date.now();
  const result = await probeLoginEnvironment({ env: { SHELL: shell, PATH: '/inherited' }, timeoutMs: 5000 });
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  assert.equal(result.env.PATH, '/opt/tools/bin:/usr/bin');
  assert.equal(result.error, undefined);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 1000;
  while (alive() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  const lingering = alive();
  if (lingering) process.kill(pid, 'SIGKILL');
  assert.equal(lingering, false, 'the background sleep outlived the probe');
});

test('a missing shell falls back with a probe error', async () => {
  const result = await probeLoginEnvironment({ env: { SHELL: join(dir, 'absent-shell'), PATH: '/inherited' } });
  assert.equal(result.env.PATH, '/inherited');
  assert.match(result.error!, /absent-shell/);
});

test('excessive shell output is bounded and never becomes diagnostic content', unixShell, async () => {
  const shell = script('excessive-output', "printf '__NORTUSCC_ENV__'; /usr/bin/head -c 1048577 /dev/zero");
  const events: Array<[StartupPhase, StartupStatus]> = [];
  const result = await probeLoginEnvironment({ env: { SHELL: shell, PATH: '/inherited' }, timeoutMs: 1000,
    onProgress: (phase, status) => events.push([phase, status]) });
  assert.match(result.error!, /output exceeds limit/);
  assert.equal(result.env.PATH, '/inherited');
  assert.ok(events.some(([phase, status]) => phase === 'environment_ready' && status === 'failed'));
  assert.ok(JSON.stringify(events).length < 2048);
});

test('throwing progress observers cannot prevent captured login environment', unixShell, async () => {
  const shell = script('observer-error', 'OBSERVED=yes\nexport OBSERVED\nexec /bin/sh -c "$2"');
  const result = await probeLoginEnvironment({ env: { SHELL: shell, PATH: '/inherited' },
    onProgress: () => { throw new Error('secret-observer-error'); } });
  assert.equal(result.error, undefined);
  assert.equal(result.env.OBSERVED, 'yes');
});

test('a shell that prints no environment falls back to the inherited one', unixShell, async () => {
  const shell = script('silent', 'exit 0');
  const result = await probeLoginEnvironment({ env: { SHELL: shell, PATH: '/inherited', KEEP: 'me' } });
  assert.deepEqual(result.env, { SHELL: shell, PATH: '/inherited', KEEP: 'me' });
  assert.match(result.error!, /no environment/);
});

test('missingTools names each tool not executable on PATH', {
  skip: process.platform === 'win32' ? 'requires POSIX executable permission bits and PATH separators' : false,
}, () => {
  const bin = mkdtempSync(join(dir, 'bin-'));
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\n');
  chmodSync(join(bin, 'npx'), 0o755);
  writeFileSync(join(bin, 'claude'), 'not executable');
  assert.deepEqual(missingTools(['npx', 'claude', 'codex'], `${bin}:/nonexistent`), [
    "'claude' was not found on the login shell's PATH",
    "'codex' was not found on the login shell's PATH",
  ]);
});

test('a login PATH without Homebrew still finds gh under a Homebrew prefix, after its own entries', unixShell, async () => {
  const prefix = mkdtempSync(join(dir, 'homebrew-'));
  const brewBin = join(prefix, 'bin');
  mkdirSync(brewBin);
  writeFileSync(join(brewBin, 'gh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(brewBin, 'gh'), 0o755);
  const empty = mkdtempSync(join(dir, 'launchd-path-'));
  const status = (env: Record<string, string>) => Effect.runPromise(ghStatus().pipe(Effect.provide(nodeProcesses({ env }))));
  // A launchd PATH, or a login shell that never set up Homebrew: gh is missing by its launch ENOENT.
  assert.equal(await status({ PATH: empty }), 'missing');
  const env = withToolDirectories({ PATH: empty, KEEP: 'me' }, [brewBin, '/usr/local/bin']);
  assert.deepEqual(env, { PATH: `${empty}:${brewBin}:/usr/local/bin`, KEEP: 'me' });
  assert.equal(await status(env), 'ready');
  assert.deepEqual(withToolDirectories({ PATH: `${brewBin}:/usr/bin` }, [brewBin, '/usr/local/bin']), { PATH: `${brewBin}:/usr/bin:/usr/local/bin` }, 'login entries keep their order; none repeats');
  assert.deepEqual(withToolDirectories({}, [brewBin]), { PATH: brewBin });
  assert.deepEqual(MACOS_TOOL_DIRECTORIES, ['/opt/homebrew/bin', '/usr/local/bin']);
});
