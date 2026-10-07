// Opt-in macOS smoke: registers the agent as a real LaunchAgent, proves it starts, that re-installing
// and restarting replace the running agent, and that it stops when removed. Run with `npm run smoke:agent` and NORTUSCC_SMOKE=1 on a Mac; skipped otherwise.
// Everything it touches is temporary: a unique label, a temp unit directory (never
// ~/Library/LaunchAgents), and temp home, state, checkout and agent directories.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Effect, Layer } from 'effect';
import { liveLockHolder, nodeFs, nodeProcesses } from '@nortuscc/machine';
import { installService, restartService, uninstallService, unitPath, type ServiceProgram, type ServiceTarget } from '../src/index.ts';

const CHECKOUT = fileURLToPath(new URL('../../..', import.meta.url));
const enabled = process.platform === 'darwin' && process.env.NORTUSCC_SMOKE === '1';
const skip = enabled ? false : 'opt-in macOS smoke: run on a Mac with NORTUSCC_SMOKE=1';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=smoke@nortuscc', '-c', 'user.name=smoke', ...args], { cwd, stdio: 'ignore' });

// A throwaway checkout holding the files the agent reads, committed once; it needs no origin.
function tempCheckout(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  for (const name of ['claude', 'codex', 'integrations.json', 'skills-manifest.txt']) {
    cpSync(join(CHECKOUT, name), join(repo, name), { recursive: true });
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'smoke');
  return repo;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

async function until(check: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(200)) if (check()) return true;
  return check();
}

const services = Layer.merge(nodeFs, nodeProcesses());

test('the agent runs as a LaunchAgent, is replaced on re-install and restart, and stops when uninstalled', { skip, timeout: 150_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nortuscc-smoke-')));
  const label = `com.nortuscc.agent.smoke.${randomBytes(6).toString('hex')}`;
  const uid = process.getuid!();
  const home = join(root, 'home');
  const state = join(root, 'state');
  const lock = join(state, 'agent', 'agent.lock');
  const logPath = join(state, 'agent', 'agent.log');
  // launchd opens the log before the agent runs, so its directory must exist.
  mkdirSync(join(state, 'agent'), { recursive: true });
  mkdirSync(home, { recursive: true });

  const target: ServiceTarget = {
    platform: 'darwin', home, uid, user: userInfo().username, stateRoot: state, label, unitDir: join(root, 'units'),
  };
  const program: ServiceProgram = {
    argv: [process.execPath, join(CHECKOUT, 'bin', 'nortuscc.mjs'), 'agent', 'run'],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      NORTUSCC_STATE_DIR: state,
      NORTUSCC_REPO_DIR: tempCheckout(root),
      NORTUSCC_CLAUDE_DIR: join(home, '.claude'),
      NORTUSCC_CODEX_DIR: join(home, '.codex'),
      NORTUSCC_OPENROUTER_CODEX_DIR: join(home, '.codex-openrouter'),
      NORTUSCC_AGENTS_DIR: join(home, '.agents', 'skills'),
    },
    workingDirectory: CHECKOUT,
    logPath,
  };
  const log = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(no agent.log)');

  let pid: number | undefined;
  try {
    assert.ok(unitPath(target).startsWith(root), `the unit must stay in the temp dir: ${unitPath(target)}`);
    await Effect.runPromise(installService(target, program).pipe(Effect.provide(services)));

    // Until IPC's `hello` (#78), a live pid in agent.lock is the proof that the agent is up.
    assert.ok(await until(() => (pid = liveLockHolder(lock)) !== undefined, 30_000), `the agent never took agent.lock:\n${log()}`);
    assert.notEqual(pid, process.pid);

    // A live agent.lock held by a pid other than `old`: the running agent was replaced.
    const replaced = async (old: number, what: string) => {
      const ok = await until(() => {
        const holder = liveLockHolder(lock);
        if (holder !== undefined) pid = holder;
        return holder !== undefined && holder !== old;
      }, 30_000);
      assert.ok(ok, `${what} did not replace agent pid ${old}:\n${log()}`);
    };

    // Re-registering over a running agent exercises bootout racing the next bootstrap.
    await Effect.runPromise(installService(target, program).pipe(Effect.provide(services)));
    await replaced(pid!, 'a second install');
    await Effect.runPromise(restartService(target, program).pipe(Effect.provide(services)));
    await replaced(pid!, 'a restart');

    await Effect.runPromise(uninstallService(target).pipe(Effect.provide(services)));
    assert.equal(existsSync(unitPath(target)), false);
    const held = pid!;
    assert.ok(await until(() => !alive(held) && !existsSync(lock), 15_000), `the agent did not stop and release agent.lock:\n${log()}`);
  } finally {
    // Whatever failed above, nothing outlives the smoke: the job is booted out and its files removed.
    try {
      execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
    if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
