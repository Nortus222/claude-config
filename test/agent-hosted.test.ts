import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { machine, runCli } from './support/cli.ts';

const skip = process.platform === 'win32' ? 'Unix IPC only' : false;
const state = { enabled: true, recovered: true, signingIn: false, accountId: 'account1', login: 'person', machineId: 'machine1', auth: 'signed-in',
  setups: [{ setupId: 'setup1', name: 'Setup', repoUrl: 'https://github.com/example/setup', latestRevision: 2 }], machine: { policy: 'notify', reportStatus: true }, lastSyncAt: null, retryAt: null, pollAfter: 900, error: null };

test('hosted CLI sends thin strict requests and prints safe device code/offers/settings', { skip }, async (t) => {
  const fixture = machine({ repo: 'checkout' });
  const root = mkdtempSync('/tmp/nhc-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const m = { ...fixture, state: root };
  mkdirSync(join(root, 'agent')); writeFileSync(join(root, 'agent', 'agent.token'), 'ipc-token');
  const seen: any[] = []; let leak = false;
  const server = createServer((socket) => {
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk;
      let newline;
      while ((newline = text.indexOf('\n')) >= 0) {
        const request = JSON.parse(text.slice(0, newline)); text = text.slice(newline + 1); seen.push(request);
        const result = request.command === 'hello' ? { agentVersion: 'fake', protocol: 3, policy: 'notify', paused: null }
          : request.command === 'signIn' ? { userCode: 'ABCD', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 120, ...(leak ? { pendingId: 'never-print-this' } : {}) }
          : request.command === 'decide' ? { at: 'now', policy: 'notify', paused: null, trusted: true, pending: [], drift: [], conflicts: [], probeErrors: [], counts: { pending: 0, held: 0, ready: 0, drift: 0 } } : state;
        socket.write(JSON.stringify({ version: 3, id: request.id, ok: true, result }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(join(root, 'agent', 'agent.sock'), resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const start = await runCli(m, ['agent', 'sign-in', 'Laptop']);
  assert.equal(start.code, 0, start.stderr); assert.match(start.stdout, /https:\/\/github.com\/login\/device.*ABCD/);
  for (const args of [['hosted'], ['trust', 'setup1'], ['sync'], ['machine', 'report-status', 'off'], ['decide', 'setup1', 'integration:hk', '2', 'accept'], ['sign-out']]) {
    const result = await runCli(m, ['agent', ...args]); assert.equal(result.code, 0, result.stderr);
  }
  assert.equal(seen.find((r) => r.command === 'decide').items[0].revision, 2);
  assert.deepEqual(seen.find((r) => r.command === 'machineSettings').patch, { reportStatus: false });
  const bad = await runCli(m, ['agent', 'trust', '../account']); assert.equal(bad.code, 2);
  leak = true;
  const unsafe = await runCli(m, ['agent', 'sign-in']); assert.equal(unsafe.code, 1);
  assert.equal((unsafe.stdout + unsafe.stderr).includes('never-print-this'), false);
});
