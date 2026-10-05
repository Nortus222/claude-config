import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const app = process.argv[2] ? resolve(process.argv[2]) : null;
const resources = app
  ? join(app, 'Contents/Resources/fixture-runtime')
  : join(root, 'src-tauri/resources/darwin-arm64');
const directory = await mkdtemp(join(tmpdir(), 'nortuscc-packaged-smoke-'));
const diagnostics = [];
function captureResources(line) {
  try {
    const record = JSON.parse(line.replace(/^(backend|host): /, ''));
    if (record.event === 'resource' || record.event === 'session') diagnostics.push(record);
  } catch {}
}
async function assertClean() {
  assert.ok(diagnostics.length, 'Smoke did not observe fixture resources');
  for (const resource of diagnostics) {
    await assert.rejects(access(resource.directory), `Directory remains: ${resource.directory}`);
    if (resource.childPid)
      assert.throws(
        () => process.kill(resource.childPid, 0),
        `Child remains: ${resource.childPid}`,
      );
  }
}
let child;
try {
  if (app) {
    child = spawn(join(app, 'Contents/MacOS/nortuscc-desktop-validation'), ['--smoke'], {
      cwd: directory,
      env: { PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    createInterface({ input: child.stderr }).on('line', captureResources);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    const [code] = await once(child, 'exit');
    clearTimeout(timeout);
    assert.equal(code, 0, output);
    assert.match(output, /Packaged Rust owner smoke passed/);
  } else {
    child = spawn(join(resources, 'bun'), [join(resources, 'backend.mjs')], {
      cwd: directory,
      env: { PATH: '', NORTUSCC_FIXTURE_SESSION: directory },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const messages = [];
    createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
    createInterface({ input: child.stderr }).on('line', captureResources);
    let nextId = 0;
    const until = async (get) => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const value = get();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      throw new Error('Smoke request timed out');
    };
    const request = async (command) => {
      const id = String(++nextId);
      child.stdin.write(JSON.stringify({ version: 1, id, command }) + '\n');
      return until(() => messages.find((message) => message.id === id));
    };
    assert.equal((await request('inspect')).result.diff.length, 2);
    assert.equal((await request('start')).ok, true);
    await until(() => diagnostics.length > 0);
    assert.equal((await request('start')).error.code, 'BUSY');
    assert.equal((await request('cancel')).ok, true);
    assert.ok(messages.some((message) => message.state === 'cancelled'));
    const exited = once(child, 'exit');
    await request('shutdown');
    assert.equal((await exited)[0], 0);
  }
  await assertClean();
  console.log(
    `${app ? 'Packaged Rust owner' : 'Bundled backend'} smoke passed with empty PATH from ${directory}`,
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.stdin?.end();
    child.kill('SIGTERM');
  }
  await rm(directory, { recursive: true, force: true });
}
