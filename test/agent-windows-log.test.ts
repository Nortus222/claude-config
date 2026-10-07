import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { BIN, cliEnv, machine } from './support/cli.ts';

// Exercise the Windows CLI decision natively and on Unix without a service manager.
for (const redirected of [false, true]) {
  test(`Windows agent ${redirected ? 'keeps regular redirected output without an own log' : 'captures piped stdout and stderr in its own log'}`, async (t) => {
    const m = machine();
    t.after(() => { rmSync(m.home, { recursive: true, force: true }); rmSync(m.bin, { recursive: true, force: true }); });
    const preload = join(m.home, 'windows-platform.mjs');
    const stopFile = join(m.home, 'stop-agent');
    const capturedStdout = 'test stdout before shutdown\n';
    const capturedStderr = 'test stderr before shutdown\n';
    const restoredStdout = 'test stdout after shutdown\n';
    const restoredStderr = 'test stderr after shutdown\n';
    writeFileSync(preload, `
import { existsSync } from 'node:fs';
const nativeWindows = process.platform === 'win32';
if (!nativeWindows) Object.defineProperty(process, 'platform', { value: 'win32' });
// child.kill('SIGTERM') terminates Windows processes without running their signal handlers.
const stop = setInterval(() => {
  if (!existsSync(${JSON.stringify(stopFile)})) return;
  clearInterval(stop);
  process.stdout.write(${JSON.stringify(capturedStdout)});
  process.stderr.write(${JSON.stringify(capturedStderr)});
  if (nativeWindows) process.emit('SIGTERM');
}, 25);
stop.unref();
// The launcher calls process.exit, so beforeExit would not run.
process.once('exit', () => {
  process.stdout.write(${JSON.stringify(restoredStdout)});
  process.stderr.write(${JSON.stringify(restoredStderr)});
});
`);
    const dir = join(m.state, 'agent');
    const logPath = join(dir, 'agent.log');
    const external = join(m.home, 'redirected.log');
    mkdirSync(dir, { recursive: true });
    const descriptor = redirected ? openSync(external, 'a') : undefined;
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, BIN, 'agent', 'run'], {
      env: cliEnv(m), stdio: descriptor === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', descriptor, descriptor],
    });
    if (descriptor !== undefined) closeSync(descriptor);
    let stdout = '', stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    let closed = false;
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => { closed = true; resolve(code); });
    });
    const waitForExit = () => Promise.race([
      exited,
      delay(5_000, undefined, { ref: false }).then(() => { throw new Error('agent did not exit within 5 seconds'); }),
    ]);
    const destination = redirected ? external : logPath;
    const waitForOutput = async (text: string) => {
      for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
        if (existsSync(destination) && readFileSync(destination, 'utf8').includes(text)) return;
        assert.equal(closed, false, `agent exited before writing ${JSON.stringify(text)}: ${stdout}${stderr}`);
        await delay(25);
      }
      assert.fail(`output was not captured: ${JSON.stringify(text)}: ${stdout}${stderr}`);
    };
    try {
      await waitForOutput('nortuscc agent: running from');
      const output = readFileSync(destination, 'utf8');
      assert.match(output, new RegExp(`nortuscc agent: running from .* \\(pid ${child.pid}\\)`));
      assert.equal(output.match(/nortuscc agent: running from/g)?.length, 1);
      assert.equal(stdout, '');
      assert.equal(stderr, '');
      assert.equal(existsSync(logPath), !redirected);
      assert.equal(existsSync(join(dir, 'agent.sock')), false);
      writeFileSync(stopFile, 'stop');
      await waitForOutput(capturedStderr);
      if (process.platform !== 'win32') child.kill('SIGTERM');
      assert.equal(await waitForExit(), 0);
      assert.equal(existsSync(join(dir, 'agent.lock')), false);
      const finalOutput = readFileSync(destination, 'utf8');
      assert.ok(finalOutput.includes(capturedStdout));
      assert.ok(finalOutput.includes(capturedStderr));
      if (redirected) {
        assert.ok(finalOutput.includes(restoredStdout));
        assert.ok(finalOutput.includes(restoredStderr));
        assert.equal(existsSync(logPath), false);
      } else {
        assert.equal(stdout, restoredStdout);
        assert.equal(stderr, restoredStderr);
        assert.equal(finalOutput.includes(restoredStdout), false);
        assert.equal(finalOutput.includes(restoredStderr), false);
      }
    } finally {
      if (!closed) child.kill('SIGKILL');
      await waitForExit();
    }
  });
}
