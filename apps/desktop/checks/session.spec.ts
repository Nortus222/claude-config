import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decodeInspectResult, decodePreviewResult, type RunProgress } from '../backend/protocol.ts';
import { Session, SessionError } from '../backend/session.ts';
import { appliedFile, fakeDomain, writeFakeMachine, type FakeItem } from './support/fake-domains.ts';

const checkout = resolve(import.meta.dirname, '../../..');

// A machine under a temporary HOME whose state.json records this checkout.
function machine(t: TestContext, items: FakeItem[], record: string | null = checkout) {
  const home = mkdtempSync(join(tmpdir(), 'nortuscc-session-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateRoot = join(home, '.config', 'nortuscc');
  mkdirSync(stateRoot, { recursive: true });
  if (record !== null) writeFileSync(join(stateRoot, 'state.json'), JSON.stringify({ version: 1, repo: record, skillsOnly: false, files: {} }));
  writeFakeMachine(stateRoot, items);
  const session = new Session({
    environment: { env: { PATH: process.env.PATH }, home, platform: process.platform },
    loginPath: { path: process.env.PATH ?? '' },
    domains: [fakeDomain],
    tools: [],
  });
  return { home, stateRoot, session };
}

async function run(session: Session, planId: string, lock?: string) {
  const prepared = await session.apply(planId);
  assert.equal(prepared.result.status, 'started');
  const events: RunProgress[] = [];
  let began!: () => void;
  const begun = new Promise<void>((resolve) => { began = resolve; });
  const ended = new Promise<void>((done) =>
    prepared.start!((_, progress) => {
      if (lock !== undefined && ['done', 'cancelled', 'failed'].includes(progress.type)) assert.equal(existsSync(lock), false, 'lock held at terminal event');
      events.push(progress);
      began();
      if (['done', 'cancelled', 'failed'].includes(progress.type)) done();
    }));
  return { events, begun, ended };
}

const code = (code: string) => (err: unknown) => err instanceof SessionError && err.code === code;

test('inspect reports the profile, items and probe errors as wire data', async (t) => {
  const { stateRoot, session } = machine(t, [{ key: 'config:a', disposition: 'apply' }]);
  const result = decodeInspectResult(await session.inspect());
  assert.equal(result.profile.repo, checkout);
  assert.match(result.profile.revision ?? '', /^[0-9a-f]{40}$/);
  assert.equal(result.profile.overrides, join(stateRoot, 'overrides.json'));
  assert.deepEqual(result.items.map((i) => [i.key, i.disposition, i.from?.source]), [['config:a', 'apply', 'fake']]);
});

test('a missing or stale checkout record names the path and the fix', async (t) => {
  await assert.rejects(machine(t, [], null).session.inspect(), (err) => code('REPO_NOT_FOUND')(err) && /no nortuscc checkout is recorded/.test((err as Error).message));
  const stale = machine(t, [], '/nonexistent/claude-config').session;
  await assert.rejects(stale.inspect(), (err) =>
    code('REPO_NOT_FOUND')(err) && /\/nonexistent\/claude-config/.test((err as Error).message) && /nortuscc setup --dir/.test((err as Error).message));
});

test('login-path and missing-tool failures are probe errors', async (t) => {
  const { home } = machine(t, []);
  const session = new Session({
    environment: { env: {}, home, platform: process.platform },
    loginPath: { path: '/nonexistent', error: 'could not read PATH from login shell /bin/zsh: timed out after 5000 ms' },
    domains: [fakeDomain],
    tools: ['claude'],
  });
  assert.deepEqual((await session.inspect()).probeErrors, [
    'could not read PATH from login shell /bin/zsh: timed out after 5000 ms',
    "'claude' was not found on the login shell's PATH",
  ]);
});

test('preview checks keys against the last inspection', async (t) => {
  const { session } = machine(t, [{ key: 'config:a', disposition: 'apply' }, { key: 'config:b', disposition: 'apply' }, { key: 'config:c', disposition: 'blocked' }]);
  assert.throws(() => session.preview([]), code('NO_REPORT'));
  await session.inspect();
  assert.throws(() => session.preview(['config:zzz']), (err) => code('UNKNOWN_KEY')(err) && /config:zzz/.test((err as Error).message));
  const preview = decodePreviewResult(session.preview(['config:b', 'config:b']));
  assert.deepEqual(preview.plan.steps.map((s) => s.key), ['config:a']);
  assert.deepEqual(preview.plan.skipped, [{ key: 'config:b', reason: 'not selected' }, { key: 'config:c', reason: 'blocked' }]);
});

test('apply runs the previewed plan, backs up, and releases the lock', async (t) => {
  const { stateRoot, session } = machine(t, [{ key: 'config:a', disposition: 'apply' }]);
  mkdirSync(join(stateRoot, 'applied'), { recursive: true });
  writeFileSync(appliedFile(stateRoot, 'config:a'), 'before\n');
  await session.inspect();
  const { events, ended } = await run(session, session.preview([]).planId, join(stateRoot, 'apply.lock'));
  assert.equal(session.running, true);
  await ended;
  assert.deepEqual(events.map((e) => e.type), ['started', 'finished', 'done']);
  const done = events.at(-1) as Extract<RunProgress, { type: 'done' }>;
  assert.equal(done.ok, 1);
  assert.equal(readFileSync(join(done.backups!, encodeURIComponent('config:a')), 'utf8'), 'before\n');
  assert.equal(readFileSync(appliedFile(stateRoot, 'config:a'), 'utf8'), 'applied\n');
  assert.equal(existsSync(join(stateRoot, 'apply.lock')), false);
  assert.equal(session.running, false);
  // The preview is consumed: it cannot be applied twice.
  await assert.rejects(session.apply('anything'), code('UNKNOWN_PLAN'));
});

test('apply refuses a stale preview and returns the new one', async (t) => {
  const { stateRoot, session } = machine(t, [{ key: 'config:a', disposition: 'apply' }]);
  await session.inspect();
  const first = session.preview([]);
  writeFakeMachine(stateRoot, [{ key: 'config:a', disposition: 'apply' }, { key: 'config:new', disposition: 'apply' }]);
  const prepared = await session.apply(first.planId);
  assert.equal(prepared.start, undefined);
  assert.equal(prepared.result.status, 'stale');
  if (prepared.result.status !== 'stale') return;
  assert.deepEqual(prepared.result.plan.steps.map((s) => s.key), ['config:a', 'config:new']);
  assert.equal(existsSync(appliedFile(stateRoot, 'config:a')), false);
  await assert.rejects(session.apply(first.planId), code('UNKNOWN_PLAN'));
  const { ended } = await run(session, prepared.result.planId);
  await ended;
});

test('busy during a run, and cancel interrupts an installer-like step', async (t) => {
  const { stateRoot, session } = machine(t, [{ key: 'config:slow', disposition: 'apply', behavior: 'slow' }, { key: 'config:b', disposition: 'apply' }]);
  await session.inspect();
  const { events, begun, ended } = await run(session, session.preview([]).planId, join(stateRoot, 'apply.lock'));
  await begun; // cancelling before the first step starts would skip it
  await assert.rejects(session.inspect(), code('BUSY'));
  assert.throws(() => session.preview([]), code('BUSY'));
  assert.equal(existsSync(join(stateRoot, 'apply.lock')), true);
  assert.equal(await session.cancel(), true);
  assert.equal(existsSync(join(stateRoot, 'apply.lock')), false); // released before cancel resolves
  await ended;
  assert.deepEqual(events.map((e) => e.type), ['started', 'finished', 'cancelled']);
  assert.deepEqual((events.at(-1) as Extract<RunProgress, { type: 'cancelled' }>).remaining, ['config:b']);
  assert.equal(existsSync(join(stateRoot, 'apply.lock')), false);
  assert.equal(await session.cancel(), false);
});

test('a live CLI holding apply.lock fails the run before any step', async (t) => {
  const { stateRoot, session } = machine(t, [{ key: 'config:a', disposition: 'apply' }]);
  await session.inspect();
  writeFileSync(join(stateRoot, 'apply.lock'), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
  const { events, ended } = await run(session, session.preview([]).planId);
  await ended;
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'failed');
  assert.match((events[0] as Extract<RunProgress, { type: 'failed' }>).message, new RegExp(`pid ${process.ppid}`));
  assert.equal(existsSync(appliedFile(stateRoot, 'config:a')), false);
});

test('profile issues block preview', async (t) => {
  const { stateRoot, session } = machine(t, [{ key: 'config:a', disposition: 'apply' }]);
  writeFileSync(join(stateRoot, 'overrides.json'), JSON.stringify({ version: 1, skills: { 'no-such-skill': true } }));
  const inspected = await session.inspect();
  assert.ok(inspected.profile.issues.length > 0);
  assert.throws(() => session.preview([]), code('PROFILE_INVALID'));
});
