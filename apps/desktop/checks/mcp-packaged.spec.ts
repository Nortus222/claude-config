import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { test } from 'node:test';

const native = process.env.DESKTOP_MCP_NATIVE_RUNTIME;
const resources = process.env.DESKTOP_AGENT_RESOURCES;
const skip = !native || !resources ? 'set DESKTOP_MCP_NATIVE_RUNTIME and DESKTOP_AGENT_RESOURCES for installed MCP acceptance' : false;
test('installed MCP reconciles inert files and recovers durable outcomes after disconnect without owning the service', { skip, timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-'));
  const app = join(root, 'App With Spaces.app');
  const temporaryRoot = join(root, 'tmp'), record = join(root, 'children.json');
  await mkdir(temporaryRoot);
  try {
    await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
    await mkdir(join(app, 'Contents/Resources'), { recursive: true });
    await cp(native!, join(app, 'Contents/MacOS/nortuscc-desktop-validation'));
    await cp(resources!, join(app, 'Contents/Resources/agent-runtime'), { recursive: true });
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/mcp-smoke.mjs', app], { cwd: new URL('..', import.meta.url), timeout: 40_000, env: { ...process.env, TMPDIR: temporaryRoot, NORTUSCC_MCP_SMOKE_RECORD: record } });
    assert.match(stdout, /MCP inspection and inert reconciliation passed/);
    assert.match(stdout, /MCP disconnect recovery and attributed History passed/);
    assert.match(stdout, /MCP terminal cancellation lookup and local-agent failure passed/);
    assert.match(stdout, /Installed app MCP smoke passed/);
  } finally {
    const owned = await readFile(record, 'utf8').then(text => JSON.parse(text) as { home: string; pids: number[] }, error => { if (error.code !== 'ENOENT') throw error; });
    if (owned) {
      assert.ok(owned.home.startsWith(await realpath(temporaryRoot) + '/mc-'));
      for (const pid of owned.pids) {
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        const alive = () => { try { process.kill(-pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
        for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
          if (!alive()) break;
          try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
          const deadline = Date.now() + 5000;
          while (alive() && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
        }
        assert.equal(alive(), false, 'Retain fixture files if its owned group is still alive');
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
