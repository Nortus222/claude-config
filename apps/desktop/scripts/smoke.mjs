import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs the bundled backend (or, given a .app, the packaged Rust owner) against a temporary HOME
// whose state.json records this checkout, with an empty PATH, from a temporary directory.
const root = fileURLToPath(new URL('..', import.meta.url));
const checkout = resolve(root, '../..');
const app = process.argv[2] ? resolve(process.argv[2]) : null;
const resources = app ? join(app, 'Contents/Resources/backend-runtime') : join(root, 'src-tauri/resources/darwin-arm64');
const home = mkdtempSync(join(tmpdir(), 'nortuscc-smoke-home-'));
const cwd = mkdtempSync(join(tmpdir(), 'nortuscc-smoke-cwd-'));
const stateRoot = join(home, '.config', 'nortuscc');
mkdirSync(stateRoot, { recursive: true });
writeFileSync(join(stateRoot, 'state.json'), JSON.stringify({ version: 1, repo: checkout, skillsOnly: false, files: {} }));
const env = { PATH: '', HOME: home };
let child;
try {
  if (app) {
    child = spawn(join(app, 'Contents/MacOS/nortuscc-desktop-validation'), ['--smoke', home], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 180_000);
    const [code] = await once(child, 'exit');
    clearTimeout(timeout);
    assert.equal(code, 0, output);
    assert.match(output, /Packaged Rust owner smoke passed/);
  } else {
    child = spawn(join(resources, 'bun'), [join(resources, 'backend.mjs')], { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
    const messages = [];
    createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
    const until = async (get, ms = 120_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const value = get();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`Smoke timed out; messages=${JSON.stringify(messages).slice(0, 2000)}`);
    };
    let nextId = 0;
    const request = (command, extra = {}) => {
      const id = String(++nextId);
      child.stdin.write(JSON.stringify({ version: 2, id, command, ...extra }) + '\n');
      return until(() => messages.find((m) => m.id === id));
    };
    const inspected = await request('inspect');
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    assert.equal(inspected.result.profile.repo, checkout);
    const preview = await request('preview', { exclude: [] });
    const applied = await request('apply', { planId: preview.result.planId });
    assert.equal(applied.result.status, 'started');
    const end = await until(() => messages.find((m) => m.runId === applied.result.runId && ['done', 'cancelled', 'failed'].includes(m.progress.type)));
    assert.equal(end.progress.type, 'done', JSON.stringify(end));
    assert.equal((await request('preview', { exclude: ['not-an-item'] })).error.code, 'UNKNOWN_KEY');
    const exited = once(child, 'exit');
    await request('shutdown');
    assert.equal((await exited)[0], 0);
  }
  assert.equal(existsSync(join(stateRoot, 'apply.lock')), false, 'apply.lock was left behind');
  console.log(`${app ? 'Packaged Rust owner' : 'Bundled backend'} smoke passed on temporary HOME ${home}`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.stdin?.end();
    child.kill('SIGTERM');
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
