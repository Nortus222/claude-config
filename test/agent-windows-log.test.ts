import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BIN, cliEnv, machine } from './support/cli.ts';

// Exercise the Windows CLI decision on Unix without invoking a service manager.
// Native Windows cannot gracefully stop this IPC-free agent with SIGTERM.
for (const redirected of [false, true]) {
  test(`Windows agent ${redirected ? 'keeps regular redirected output without an own log' : 'captures piped stdout and stderr in its own log'}`, { skip: process.platform === 'win32' }, async (t) => {
    const m = machine();
    t.after(() => { rmSync(m.home, { recursive: true, force: true }); rmSync(m.bin, { recursive: true, force: true }); });
    const preload = join(m.home, 'windows-platform.mjs');
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' });\n");
    const dir = join(m.state, 'agent');
    const logPath = join(dir, 'agent.log');
    const external = join(m.home, 'redirected.log');
    mkdirSync(dir, { recursive: true });
    const descriptor = redirected ? openSync(external, 'a') : undefined;
    const child = spawn(process.execPath, ['--import', preload, BIN, 'agent', 'run'], {
      env: cliEnv(m), stdio: descriptor === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', descriptor, descriptor],
    });
    if (descriptor !== undefined) closeSync(descriptor);
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const destination = redirected ? external : logPath;
    try {
      for (const deadline = Date.now() + 15_000; Date.now() < deadline && (!existsSync(destination) || !readFileSync(destination, 'utf8').includes('nortuscc agent: running from'));) await delay(25);
      assert.ok(existsSync(destination), `startup output was not captured: ${stderr}`);
      const output = readFileSync(destination, 'utf8');
      assert.match(output, new RegExp(`nortuscc agent: running from .* \\(pid ${child.pid}\\)`));
      assert.equal(output.match(/nortuscc agent: running from/g)?.length, 1);
      assert.equal(stderr, '');
      assert.equal(existsSync(logPath), !redirected);
      assert.equal(existsSync(join(dir, 'agent.sock')), false);
      child.kill('SIGTERM');
      assert.equal(await exited, 0);
      assert.equal(existsSync(join(dir, 'agent.lock')), false);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
}
