import { test } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import { Backups, backupsForRun, machinePaths, nodeFs, type Domain, type MachineReport, type Plan, type Step } from '@nortuscc/machine';

import { forTargets, runPlan } from '../src/machine.ts';

const integration = (id: string, target: string) => ({
  id, enabled: true, from: { layer: 'base' as const, source: 'integrations.json' },
  declaration: { id, default: true, target, type: 'hook' },
});

const desired: DesiredConfig = {
  files: [], skills: [], allow: {}, issues: [],
  integrations: [integration('a', 'claude'), integration('b', 'codex'), integration('c', 'claude')],
};

test('forTargets keeps only the selected agents\' integrations', () => {
  assert.deepEqual(forTargets(desired, ['claude']).integrations.map((i) => i.id), ['a', 'c']);
  assert.deepEqual(forTargets(desired, ['claude', 'codex']).integrations.map((i) => i.id), ['a', 'b', 'c']);
});

test('runPlan returns each step\'s result and the run\'s backup folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nortuscc-machine-'));
  try {
    const live = join(root, 'live.txt');
    writeFileSync(live, 'before\n');
    const paths = {
      repo: join(root, 'repo'), claude: join(root, 'claude'), codex: join(root, 'codex'),
      codexOpenRouter: join(root, 'codex-openrouter'), agentsSkills: join(root, 'agents'),
      stateRoot: join(root, 'state'), backups: join(root, 'state', 'backups'),
    };
    const step: Step = { key: 'k', domain: 'config', action: 'write-file', summary: 'write k', touches: [live], interruptible: false };
    const fake: Domain<Backups> = {
      name: 'config',
      inspect: () => Effect.succeed({ items: [], probeErrors: [] }),
      steps: () => ({ steps: [step], skipped: [] }),
      run: () => Effect.gen(function* () {
        yield* (yield* Backups).preserve(live, 'live.txt');
        return { ok: true, note: 'x' };
      }),
    };
    const plan: Plan = { kind: 'apply', steps: [step], skipped: [] };
    const report: MachineReport = { desired, items: [], probeErrors: [] };
    const started: string[] = [];

    const ran = await Effect.runPromise(runPlan(plan, report, [fake], { onStarted: (s) => started.push(s.key) }).pipe(
      Effect.provide(backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs)))),
    ));

    assert.deepEqual(ran.results, [{ step, outcome: 'ok', note: 'x' }]);
    assert.equal(ran.cancelled, false);
    assert.deepEqual(started, ['k']);
    assert.ok(ran.backups?.startsWith(paths.backups), `backups under the temp state root: ${ran.backups}`);
    assert.equal(readFileSync(join(ran.backups!, 'live.txt'), 'utf8'), 'before\n');
    assert.equal(existsSync(join(paths.stateRoot, 'apply.lock')), false, 'the apply lock is released');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runPlan stops before the first step once the signal has fired', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nortuscc-machine-'));
  try {
    const paths = {
      repo: root, claude: root, codex: root, codexOpenRouter: root, agentsSkills: root,
      stateRoot: join(root, 'state'), backups: join(root, 'state', 'backups'),
    };
    const step: Step = { key: 'k', domain: 'config', action: 'write-file', summary: 'write k', touches: [], interruptible: false };
    const fake: Domain = {
      name: 'config',
      inspect: () => Effect.succeed({ items: [], probeErrors: [] }),
      steps: () => ({ steps: [step], skipped: [] }),
      run: () => Effect.succeed({ ok: true }),
    };
    const controller = new AbortController();
    controller.abort();
    const ran = await Effect.runPromise(
      runPlan({ kind: 'apply', steps: [step], skipped: [] }, { desired, items: [], probeErrors: [] }, [fake], { signal: controller.signal })
        .pipe(Effect.provide(backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs))))),
    );
    assert.deepEqual(ran.results, []);
    assert.equal(ran.cancelled, true);
    assert.equal(ran.backups, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A body that never checks its signal: the first Ctrl-C only aborts it, the second ends the process.
test('runCommand: a second SIGINT exits the process with 130', { timeout: 15_000 }, async (t) => {
  const script = `
    import { Effect } from 'effect';
    import { runCommand } from ${JSON.stringify(new URL('../src/machine.ts', import.meta.url).href)};
    if (process.platform === 'win32') process.on('message', () => process.emit('SIGINT'));
    await runCommand((signal) => Effect.promise(() => new Promise(() => {
      signal.addEventListener('abort', () => process.stdout.write('aborted\\n'));
      setInterval(() => {}, 1000);
      process.stdout.write('ready\\n');
    })));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  const stdout = child.stdout;
  assert.ok(stdout);
  let out = '';
  const waitFor = (text: string) => new Promise<void>((resolve) => {
    const check = () => { if (out.includes(text)) { stdout.off('data', onData); resolve(); } };
    const onData = (chunk: Buffer) => { out += chunk; check(); };
    stdout.on('data', onData);
    check();
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  // Windows child.kill terminates the child instead of invoking its signal handler.
  const interrupt = () => process.platform === 'win32' ? child.send('interrupt') : child.kill('SIGINT');

  await waitFor('ready');
  interrupt();
  await waitFor('aborted');
  interrupt();
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 5_000).unref());
  assert.equal(await Promise.race([exited, timeout]), 130);
});
