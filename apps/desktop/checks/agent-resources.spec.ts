import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { MachinePathsValue } from '@nortuscc/machine';
import { connectAgent, type AgentConnection } from '../../../src/agent-client.ts';

// Resource checks run explicitly after packaging, against a temporary home without registration.
const resources = process.env.DESKTOP_AGENT_RESOURCES;
const skip = resources === undefined ? 'set DESKTOP_AGENT_RESOURCES after bundling' : false;

test('resources contain only the agent runtime, hashed version and bundled license notices', { skip }, () => {
  assert.deepEqual(readdirSync(resources!).sort(), ['BUN-LICENSE.md', 'EFFECT-LICENSE', 'agent.mjs', 'bun', 'runtime.json']);
  const metadata = JSON.parse(readFileSync(join(resources!, 'runtime.json'), 'utf8'));
  assert.equal(metadata.agentVersion, createHash('sha256').update(readFileSync(join(resources!, 'agent.mjs'))).digest('hex'));
  assert.equal(metadata.executable, 'bun');
});

test('packaged agent serves socket clients on temporary HOME and prints no helper result in foreground', { skip, timeout: 15000 }, async (t) => {
  const home = mkdtempSync('/tmp/nar-');
  const stateRoot = join(home, 's');
  const repo = join(home, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(stateRoot);
  writeFileSync(join(stateRoot, 'state.json'), JSON.stringify({ repo }));
  const shell = join(home, 'shell');
  writeFileSync(shell, '#!/bin/sh\nexec /bin/sh -c "$2"\n');
  chmodSync(shell, 0o755);
  const child = spawn(join(resolve(resources!), 'bun'), [join(resolve(resources!), 'agent.mjs')], {
    env: { HOME: home, PATH: '', SHELL: shell, NORTUSCC_STATE_DIR: stateRoot }, stdio: ['ignore', 'pipe', 'pipe'], cwd: '/',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    rmSync(home, { recursive: true, force: true });
  });
  const paths: MachinePathsValue = { repo, stateRoot, backups: join(stateRoot, 'backups'), claude: join(home, '.claude'), codex: join(home, '.codex'), codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents/skills') };
  let conn: AgentConnection | undefined;
  const deadline = Date.now() + 8000;
  while (!conn && Date.now() < deadline && child.exitCode === null) {
    try { conn = await connectAgent(paths, { client: 'app', timeoutMs: 100 }); } catch { await new Promise((done) => setTimeout(done, 10)); }
  }
  assert.ok(conn, stderr);
  try {
    const metadata = JSON.parse(readFileSync(join(resources!, 'runtime.json'), 'utf8'));
    assert.equal(conn.hello.agentVersion, metadata.agentVersion);
    await conn.request({ command: 'shutdown' });
    assert.equal((await exited)[0], 0, stderr);
    assert.equal(stdout, '');
  } finally { conn.close(); }
});
