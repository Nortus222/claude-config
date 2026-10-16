import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { STARTUP_PREFIX } from '../agent/startup-diagnostics.ts';

const source = fileURLToPath(new URL('../agent/main.ts', import.meta.url));
const gatedDependency = fileURLToPath(new URL('../agent/public-config.ts', import.meta.url));
const records = (stderr: string) => stderr.split('\n').filter(line => line.startsWith(STARTUP_PREFIX)).map(line => JSON.parse(line.slice(STARTUP_PREFIX.length)));

// Gate a real bundled dependency to observe the executable boundary before module evaluation finishes.
const gatedEntry = async (fail: boolean) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ncc-entry-loader-')));
  const entry = join(root, 'agent.mjs');
  try {
    await build({ entryPoints: [source], outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'esnext',
      // The fixture also runs on Node ESM; the shipped Bun runtime supplies CommonJS require itself.
      banner: { js: 'import { createRequire as entryFixtureRequire } from "node:module"; const require = entryFixtureRequire(import.meta.url);' },
      plugins: [{ name: 'dependency-load-gate', setup: plugin => {
        plugin.onLoad({ filter: /desktop\/agent\/public-config\.ts$/ }, async args => {
          if (args.path !== gatedDependency) return;
          const gate = 'process.stderr.write("LOAD_GATE_READY\\n"); await new Promise(resolve => process.stdin.once("data", resolve));\n';
          return { contents: gate + (fail ? 'throw new Error("PRIVATE_IMPORT_FAILURE");\n' : '') + await readFile(args.path, 'utf8'), loader: 'ts', resolveDir: dirname(args.path) };
        });
      } }], logLevel: 'silent' });
    const child = spawn(process.execPath, [entry, '--unrecognized'], { cwd: root,
      env: { HOME: root, PATH: '/inert', NORTUSCC_STATE_DIR: join(root, 'state') }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000, killSignal: 'SIGKILL' });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    let ready!: () => void;
    const gateReady = new Promise<void>(resolve => { ready = resolve; });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.includes('LOAD_GATE_READY\n')) ready(); });
    const closed = once(child, 'close');
    return { root, child, closed, gateReady, output: () => ({ stdout, stderr }), cleanup: async () => {
      if (!child.stdin.writableEnded) child.stdin.end('release\n');
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      await rm(root, { recursive: true, force: true });
    } };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
};

test('bundled entry records module loading before a slow dependency, then delegates once', { timeout: 15_000 }, async () => {
  const run = await gatedEntry(false);
  try {
    await Promise.race([run.gateReady, run.closed.then(() => { throw new Error('entry exited before dependency gate'); })]);
    const pending = records(run.output().stderr);
    assert.ok(pending.some(record => record.phase === 'module_load' && record.status === 'started'), 'an early marker must precede gated module evaluation');
    assert.equal(pending.some(record => record.phase === 'entry'), false);
    run.child.stdin.end('release\n');
    assert.deepEqual(await run.closed, [1, null]);
    const events = records(run.output().stderr);
    assert.deepEqual(events.slice(0, 3).map(record => [record.phase, record.status]), [['module_load', 'started'], ['module_load', 'completed'], ['entry', 'started']]);
    assert.equal(run.output().stdout, '');
  } finally { await run.cleanup(); }
});

test('bundled import failure keeps diagnostics fixed and hides dependency exception text', { timeout: 15_000 }, async () => {
  const run = await gatedEntry(true);
  try {
    await Promise.race([run.gateReady, run.closed.then(() => { throw new Error('entry exited before dependency gate'); })]);
    run.child.stdin.end('release\n');
    assert.deepEqual(await run.closed, [1, null]);
    const output = run.output();
    assert.deepEqual(records(output.stderr).map(record => [record.phase, record.status]), [['module_load', 'started'], ['module_load', 'failed']]);
    assert.equal(output.stderr.includes('PRIVATE_IMPORT_FAILURE'), false);
    assert.equal(output.stderr.includes(run.root), false);
    assert.equal(output.stdout, '');
  } finally { await run.cleanup(); }
});
