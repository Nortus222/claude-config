import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { Effect } from 'effect';
import { configDomain, inspect, plan, selectAll } from '@nortuscc/machine';
import { openDesired, runPlan } from '../src/machine.ts';
import { coherenceFixture } from './support/checkout-coherence.ts';
import { installerCalls, machine, runCli, writeFakeBin } from './support/cli.ts';

function fixture(t: { after: (f: () => void) => void }) {
  const f = coherenceFixture(); t.after(() => rmSync(f.home, { recursive: true, force: true }));
  return f;
}
function snapshot(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name !== 'apply.lock')
    .map(e => { const path = join(e.parentPath, e.name); return [relative(root, path), readFileSync(path).toString('base64')]; }));
}
function blackbox(t: { after: (f: () => void) => void }) {
  const f = fixture(t);
  const m = { ...machine({ repo: 'checkout' }), home: f.home, repo: f.repo, state: f.paths.stateRoot,
    claude: f.paths.claude, codex: f.paths.codex, openrouter: f.paths.codexOpenRouter, agents: f.paths.agentsSkills, log: join(f.home, 'install.log') };
  // Block every transport or mutating Git command. Read-only guard commands may use this fixture.
  writeFakeBin(m.bin, 'git', `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nimport { appendFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst a=process.argv.slice(2); let i=0; while(['-c','-C','--git-dir','--work-tree'].includes(a[i])) i+=2;\nif(process.env.NORTUSCC_COHERENCE_AUTHOR) { if(['add','commit','push'].includes(a[i])) { appendFileSync(join(process.env.HOME,'author-git.log'),a[i]+'\\n'); process.exit(0); } if(a[i]==='diff'&&a.includes('--quiet')) process.exit(1); }\nif(process.env.NORTUSCC_COHERENCE_UPSTREAM) { if(a[i]==='symbolic-ref') { console.log('main'); process.exit(0); } if(a[i]==='config') { console.log(a.at(-1).endsWith('.remote')?'origin':'refs/heads/main'); process.exit(0); } if(a[i]==='rev-parse'&&a.at(-1).includes('refs/remotes/origin/main')) { console.log(process.env.NORTUSCC_COHERENCE_UPSTREAM); process.exit(0); } }\nif(!['rev-parse','merge-base','ls-files','ls-tree','cat-file','symbolic-ref','config','rev-list','diff'].includes(a[i])) { process.stderr.write('blocked fixture Git '+a[i]); process.exit(91); }\nconst r=spawnSync('/usr/bin/git',a,{env:process.env,stdio:'inherit'}); process.exit(r.status??1);\n`);
  return { f, m, env: Object.fromEntries(Object.entries(f.env).filter((e): e is [string,string] => e[1] !== undefined && e[0] !== 'PATH')) };
}

test('CLI refuses machine changes when its checkout is behind the applied baseline', async t => {
  const f = fixture(t); f.state();
  for (const head of [f.A, f.C]) {
    f.git('update-ref', 'refs/heads/main', head);
    await assert.rejects(Effect.runPromise(Effect.scoped(openDesired({ paths: f.paths }))), /checkout/i);
  }
});

test('CLI accepts a checkout containing the baseline with dirty edits', async t => {
  const f = fixture(t); f.state();
  f.git('update-ref', 'refs/heads/main', f.D);
  writeFileSync(join(f.repo, 'claude', 'CLAUDE.md'), 'staged author\n'); f.git('add', '.');
  writeFileSync(join(f.repo, 'claude', 'CLAUDE.md'), 'dirty author\n');
  const stagedBytesBefore = f.index();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const opened = yield* openDesired({ paths: f.paths });
    const report = yield* inspect(opened.desired, [configDomain]).pipe(Effect.provide(opened.layer));
    assert.ok(report.items.some(i => i.disposition === 'apply'));
    const p = plan('apply', report, { ...selectAll, targets: ['claude'] }, [configDomain]);
    yield* runPlan(p, report, [configDomain], { preflight: opened.preflight }).pipe(Effect.provide(opened.layer));
  })));
  assert.equal(readFileSync(join(f.paths.claude, 'CLAUDE.md'), 'utf8'), 'dirty author\n');
  assert.deepEqual(f.index(), stagedBytesBefore);
  assert.equal(f.git('rev-parse', 'HEAD'), f.D);
});

for (const args of [['apply', '--skills-only', '--install', '--yes'], ['update', '--yes'], ['setup', '--yes', '--skills-only'], ['uninstall', '--yes'], ['sync', '--release', 'file:claude:CLAUDE.md']]) {
  test(`${args[0]} refuses stale checkout before any producer writes`, async t => {
    const { f, m, env } = blackbox(t); f.state();
    writeFileSync(join(f.paths.stateRoot, 'sync.json'), JSON.stringify({ version: 1, held: { 'file:claude:CLAUDE.md': f.A } }));
    const before = snapshot(f.home);
    const r = await runCli(m, args, { env });
    assert.notEqual(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /checkout/i);
    assert.deepEqual(installerCalls(m), []);
    assert.deepEqual(snapshot(f.home), before);
  });
}
test('executor rereads original checkout baseline after planning and emits no started events on refusal', async t => {
  const f = fixture(t); f.git('update-ref', 'refs/heads/main', f.B); f.state();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const opened = yield* openDesired({ paths: f.paths });
    const report = yield* inspect(opened.desired, [configDomain]).pipe(Effect.provide(opened.layer));
    const p = plan('apply', report, selectAll, [configDomain]);
    f.state(f.D);
    const started: unknown[] = [];
    const result = yield* Effect.exit(runPlan(p, report, [configDomain], { preflight: opened.preflight, onStarted: s => started.push(s) }).pipe(Effect.provide(opened.layer)));
    assert.equal(result._tag, 'Failure'); assert.deepEqual(started, []);
    assert.equal(existsSync(join(f.paths.claude, 'CLAUDE.md')), false);
  })));
});

test('capture and fake-transport push retain authoring behavior on a checkout behind applied', async t => {
  const { f, m, env } = blackbox(t); f.state();
  mkdirSync(f.paths.claude, { recursive: true });
  mkdirSync(join(f.paths.agentsSkills, 'seed'), { recursive: true });
  writeFileSync(join(dirname(f.paths.agentsSkills), '.skill-lock.json'), JSON.stringify({ skills: { seed: { source: 'o/r' } } }));
  writeFileSync(join(f.repo, 'skills-manifest.txt'), '[o/r]\nseed\n');
  writeFileSync(join(f.paths.claude, 'CLAUDE.md'), 'local authored rules\n');
  writeFileSync(join(f.paths.claude, 'settings.json'), '{"fixture":true}\n');
  const r = await runCli(m, ['capture', '--target', 'claude', '--take-local'], { env });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(f.repo, 'claude', 'CLAUDE.md'), 'utf8'), 'local authored rules\n');
  const pushed = await runCli(m, ['push', '-m', 'fixture authoring', '--skills-only'], { env: { ...env, NORTUSCC_COHERENCE_AUTHOR: '1' } });
  assert.equal(pushed.code, 0, pushed.stderr);
  assert.deepEqual(readFileSync(join(f.home, 'author-git.log'), 'utf8').trim().split('\n'), ['add', 'commit', 'push']);
});

test('malformed applied and unavailable recorded commits refuse before legacy mode migration', async t => {
  const { f, m, env } = blackbox(t);
  for (const applied of ['malformed', 'f'.repeat(40)]) {
    f.state(applied);
    const path = join(f.paths.stateRoot, 'state.json');
    const state = JSON.parse(readFileSync(path, 'utf8')); state.skillsOnly = true; writeFileSync(path, JSON.stringify(state));
    const before = snapshot(f.home);
    const r = await runCli(m, ['apply', '--no-skills-only'], { env });
    assert.equal(r.code, 1); assert.deepEqual(snapshot(f.home), before); assert.deepEqual(installerCalls(m), []);
  }
});

test('first setup without an applied field remains valid and candidate setup is checked before recording root', async t => {
  const { f, m, env } = blackbox(t);
  const initial = await runCli(m, ['setup', '--yes', '--target', 'claude', '--no-hooks', '--no-mcp', '--no-plugins', '--no-skills'], { env });
  assert.equal(initial.code, 0, initial.stdout + initial.stderr);
  assert.equal(readFileSync(join(f.paths.claude, 'CLAUDE.md'), 'utf8'), 'fixture rules\n');
  const candidate = fixture(t);
  f.git('update-ref', 'refs/heads/main', f.B); f.state();
  const before = snapshot(f.home);
  const r = await runCli(m, ['setup', '--yes', '--dir', candidate.repo, '--skills-only'], { env });
  assert.equal(r.code, 1); assert.match(r.stderr, /checkout/i); assert.deepEqual(snapshot(f.home), before);
});

test('service-free preflight retains original Fs/Processes and runs under executor lock with config-only services', async t => {
  const f = fixture(t); f.git('update-ref', 'refs/heads/main', f.B); f.state();
  const { Backups, Fs, MachinePaths, Processes, nodeFs, nodeProcesses } = await import('@nortuscc/machine');
  const { checkoutPreflight } = await import('../src/machine.ts');
  const fs = Effect.runSync(Fs.pipe(Effect.provide(nodeFs)));
  const processes = Effect.runSync(Processes.pipe(Effect.provide(nodeProcesses({ env: f.env }))));
  const preflight = await Effect.runPromise(checkoutPreflight(f.paths).pipe(
    Effect.provideService(Fs, fs), Effect.provideService(Processes, { run: command => {
      assert.equal(command.cwd, f.repo);
      assert.ok(existsSync(join(f.paths.stateRoot, 'apply.lock')));
      return processes.run(command);
    } }),
  ));
  const configOnly = { name: 'config' as const, inspect: () => Effect.succeed({ items: [], probeErrors: [] }), steps: () => ({ steps: [], skipped: [] }), run: () => Effect.succeed({ ok: true }) };
  const ran = await Effect.runPromise(runPlan({ kind: 'apply', steps: [], skipped: [] }, { desired: { files: [], skills: [], integrations: [], allow: {}, issues: [] }, items: [], probeErrors: [] }, [configOnly], { preflight }).pipe(
    Effect.provideService(MachinePaths, { ...f.paths, repo: join(f.home, 'composed-unrelated') }),
    Effect.provideService(Backups, { preserve: () => Effect.succeed(undefined), moveAside: () => Effect.succeed(undefined), dir: Effect.succeed(undefined) }),
  ));
  assert.deepEqual(ran.results, []);
});

test('setup --dir checks the selected compatible checkout while preserving the older original checkout', async t => {
  const { f, m, env } = blackbox(t); f.state();
  f.git('update-ref', 'refs/heads/main', f.D);
  const candidate = join(f.home, 'candidate'); cpSync(f.repo, candidate, { recursive: true });
  f.git('update-ref', 'refs/heads/main', f.A);
  const before = snapshot(f.repo);
  const r = await runCli(m, ['setup', '--yes', '--dir', candidate, '--target', 'claude', '--no-skills', '--no-hooks', '--no-mcp', '--no-plugins'], { env: { ...env, NORTUSCC_REPO_DIR: '' } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(readFileSync(join(f.paths.stateRoot, 'state.json'), 'utf8')).repo, candidate);
  assert.deepEqual(snapshot(f.repo), before);
});


test('an invalid applied timestamp is refused before a store can discard the baseline', async t => {
  const { f, m, env } = blackbox(t); f.git('update-ref', 'refs/heads/main', f.B); f.state();
  const path = join(f.paths.stateRoot, 'state.json');
  const state = JSON.parse(readFileSync(path, 'utf8')); state.applied.at = 'invalid';
  writeFileSync(path, JSON.stringify(state));
  const before = snapshot(f.home);
  const result = await runCli(m, ['apply', '--skills-only', '--no-skills', '--yes'], { env });
  assert.equal(result.code, 1); assert.match(result.stderr, /checkout/i);
  assert.deepEqual(snapshot(f.home), before);
});
