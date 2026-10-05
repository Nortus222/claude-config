# Desktop Real Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop app inspects, previews, applies and cancels on the real machine through `@nortuscc/machine`, replacing the Fixture Lab (issue #58, sub-issue 5/6 of #42).

**Architecture:** The Bun backend builds `MachinePaths` with `pathsFromEnvironment` (no fallback repo), reads PATH once from the user's login shell, and keeps one `Session` that holds the last inspection and the last preview. Protocol v2 (JSON lines, 1 MiB records) carries `inspect`, `preview { exclude }`, `apply { planId }`, `cancel` and `shutdown`; `apply` re-inspects and re-plans and answers `stale` with a fresh preview when `samePlan` fails. Rust allow-lists the same five requests with per-command timeouts and forwards run events; the React renderer shows the profile, an inspect table grouped by domain, the preview and a cancellable apply. Separately, legacy `.mjs` commands that rewrite `state.json` take `<stateRoot>/apply.lock`.

**Tech Stack:** TypeScript (Node 24 type stripping, `tsx` for desktop checks), Effect 4.0.1 (`Effect`, `Stream`, `Layer`, `Schema`), React 19, Tauri 2 (Rust), esbuild, bundled Bun 1.3.14, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-05-machine-rebuild-design.md`, section "Desktop app" (plus "Execute" and "Services"). Issue #58 and its comment.

## Global Constraints

- Node 24+. New code is erasable-syntax TypeScript with `.ts` import extensions; legacy `.mjs` is only edited, never added. `node:`-prefixed builtin imports.
- The one new runtime dependency is none: `effect` 4.0.1 (pinned) plus the workspace packages `@nortuscc/machine` and `@nortuscc/profile-engine`.
- #39 rule: **the renderer can never choose a path or a command.** It sends only opaque item keys taken from the report and opaque plan ids. Rust and the backend both allow-list commands.
- Protocol v2: JSON lines, `version: 2`, records at most **1,048,576 bytes** (was 16,384), requests `inspect`, `preview { exclude: key[] }`, `apply { planId }`, `cancel`, `shutdown` — nothing else (the fixture's `start` and `crash` go away).
- The backend calls `pathsFromEnvironment({ env, home, platform })` with **no `fallbackRepo`**, so a stale record fails `RepoNotFound { recorded }`, which must reach the user with the recorded path.
- Login-shell PATH: `$SHELL -ilc <fixed script>` with a fixed argv and a timeout, run once at startup. A missing tool is a probe failure in the report, not a crash.
- Rust passes the backend no paths. Rust tests and the packaged smoke run against a temporary `HOME` passed through the environment.
- Do not edit `packages/machine` or `packages/profile-engine`. Stay inside `apps/desktop`, plus the legacy lock change (`src/lock.mjs`, `src/main.ts`, `bin/`, their tests).
- Comments state purpose or contract, not narration. Conventional-commit prefixes. No `Co-Authored-By` trailer. Commit after every task.
- macOS arm64 only for the app.
- Root `npm test` can rewrite `skills-manifest.txt`: run `git status` after it, `git checkout -- skills-manifest.txt` if changed, never commit it.
- Cargo lives at `~/.cargo/bin/cargo` (not on PATH): use `PATH="$HOME/.cargo/bin:$PATH"`.
- `npm run resources -w apps/desktop` needs `DESKTOP_BUN_LICENSE`. Fetch it once, outside the repo:
  `mkdir -p ~/.cache/nortuscc && curl -fsSL https://raw.githubusercontent.com/oven-sh/bun/bun-v1.3.14/LICENSE.md -o ~/.cache/nortuscc/bun-LICENSE.md` and `export DESKTOP_BUN_LICENSE=~/.cache/nortuscc/bun-LICENSE.md` (Bun on PATH is 1.3.14).
- Domains: none of #55 (config), #56 (integrations), #57 (skills) has merged into the base branch. `backend/domains.ts` ships an empty list; behavior is tested with fake domains in `checks/support/`. Do not invent real domains.

## Review Focus

1. **Stale or missing recorded checkout.** The user expects to be told which path is recorded and how to fix it, not a generic failure, and the app should stay connected so they can inspect again after fixing it. → Task 4 (session), Task 5 (stdio), Task 6 (Rust), Task 7 (controller keeps `connected`).
2. **A login shell that prints banners, hangs, or does not exist.** PATH must come from between markers, the probe must give up after its timeout, and the inherited PATH is used with a probe error. → Task 3.
3. **Window closed, EOF or shutdown mid-apply.** The current file step finishes, the lock is released, and the backend exits; an abrupt kill leaves a dead-pid lock that the next run takes over. → Task 5.
4. **A CLI run holds `apply.lock` when the app applies (and the reverse).** The app's run ends `failed` naming the holder pid with no step run; a legacy CLI writer is refused while the app holds it. → Task 1, Task 4.
5. **A real report larger than the old 16 KB cap.** Hundreds of items must round-trip through the backend and Rust. → Task 5 (large fake report), Task 6 (1 MiB `bounded_line`).

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `src/lock.mjs` (modify) | `withApplyLock(fn)`: the legacy CLI's hold on `<stateRoot>/apply.lock`, same file format as `@nortuscc/machine` |
| `bin/commands.mjs` (modify) | `LOCKED`: legacy verbs that rewrite `state.json` |
| `src/main.ts`, `bin/nortuscc.mjs` (modify) | Wrap `LOCKED` legacy verbs in `withApplyLock` |
| `apps/desktop/backend/protocol.ts` (rewrite) | Protocol v2 Schemas: requests, envelopes, wire payloads, decoders |
| `apps/desktop/backend/login-path.ts` (new) | `probeLoginPath`, `missingTools` |
| `apps/desktop/backend/session.ts` (new) | `Session`: inspect / preview / apply (STALE) / cancel over `@nortuscc/machine` |
| `apps/desktop/backend/domains.ts` (new) | The domains this build wires in (empty until #55–#57 merge) |
| `apps/desktop/backend/server.ts` (new) | stdio JSON-lines framing, dispatch, `startBackend(domains)` |
| `apps/desktop/backend/main.ts` (rewrite) | Entry: `await startBackend(domains)` |
| `apps/desktop/backend/fixture.ts`, `operation.ts`, `checks/fixture.spec.ts` (delete) | Fixture code |
| `apps/desktop/checks/support/fake-domains.ts`, `fake-backend.ts` (new) | Test-only domain driven by a JSON file, and an entry that serves it |
| `apps/desktop/checks/{protocol,login-path,session,backend,controller}.spec.ts` | Tests |
| `apps/desktop/src-tauri/src/host.rs`, `main.rs`, `tauri.conf.json` (modify) | v2 host: `Request` allow-list, 1 MiB, timeouts, no session dir, Tauri commands, smoke |
| `apps/desktop/src/bridge.ts`, `controller.ts`, `main.tsx`, `style.css` (rewrite) | Renderer |
| `apps/desktop/scripts/smoke.mjs`, `bundle.mjs`, `package.json`, `README.md` (modify) | Smoke on a temporary HOME, bundling fixes, docs |

Typecheck note: Tasks 2–6 change the backend contract before Task 7 rewrites the renderer. Between them, `npm run typecheck -w apps/desktop` reports errors **only** in `src/` and `checks/controller.spec.ts`; each task's typecheck step says so. Task 7 restores a clean typecheck.

---

### Task 1: Legacy state writers take `apply.lock`

**Files:**
- Modify: `src/lock.mjs`
- Modify: `bin/commands.mjs`
- Modify: `src/main.ts`
- Modify: `bin/nortuscc.mjs` (legacy fallback branch near the end)
- Test: `test/lock.test.mjs`, `test/main.test.ts`

**Interfaces:**
- Produces: `withApplyLock(fn: () => Promise<number>): Promise<number>` in `src/lock.mjs`; `LOCKED: string[]` in `bin/commands.mjs`.
- Lock file contract (must match `packages/machine/src/apply-lock.ts`): `<stateRoot>/apply.lock` containing `{"pid":<int>,"startedAt":"<iso>"}`, created by `link()` of a fully written temp file; a holder whose pid is dead is taken over once; release removes the file only when it still names this pid.

- [ ] **Step 1: Write the failing lock tests** — append to `test/lock.test.mjs` (it already sets `NORTUSCC_STATE_DIR` to a temp dir and imports from `../src/lock.mjs`; add `withApplyLock` to that import):

```js
test('withApplyLock holds apply.lock while fn runs and releases it after', async () => {
  const lockPath = join(stateRoot(), 'apply.lock');
  let seen;
  const code = await withApplyLock(async () => {
    seen = JSON.parse(readFileSync(lockPath, 'utf8'));
    return 0;
  });
  assert.equal(code, 0);
  assert.equal(seen.pid, process.pid);
  assert.equal(existsSync(lockPath), false);
});

test('withApplyLock refuses while another live process holds the lock', async () => {
  const lockPath = join(stateRoot(), 'apply.lock');
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(String(line));
  let ran = false;
  try {
    const code = await withApplyLock(async () => { ran = true; return 0; });
    assert.equal(code, 1);
  } finally {
    console.error = original;
    rmSync(lockPath, { force: true });
  }
  assert.equal(ran, false);
  assert.match(errors.join('\n'), new RegExp(`another nortuscc run \\(pid ${process.ppid}\\) holds .*apply\\.lock`));
});

test('withApplyLock takes over a lock whose holder died, and releases on throw', async () => {
  const lockPath = join(stateRoot(), 'apply.lock');
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: '2026-01-01T00:00:00.000Z' }));
  await assert.rejects(withApplyLock(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(lockPath), false);
});
```

(`2 ** 22 + 12345` exceeds macOS's pid range, so it is never alive.)

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/lock.test.mjs`
Expected: FAIL — `withApplyLock` is not exported.

- [ ] **Step 3: Implement `withApplyLock` in `src/lock.mjs`**

Add `linkSync` to the existing `node:fs` import and `import { randomUUID } from 'node:crypto';` (merge with the existing `createHash` import). Append:

```js
function lockHolder(path) {
  try {
    const pid = JSON.parse(readFileSync(path, 'utf8')).pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Runs `fn` holding <stateRoot>/apply.lock, the lock @nortuscc/machine's executor takes, so a
// legacy command that reads state.json and rewrites it whole never overlaps a desktop or
// TypeScript run. Same file format; a lock whose holder died is taken over. Returns fn's exit
// code, or 1 after naming a live holder.
export async function withApplyLock(fn) {
  const root = stateRoot();
  const path = join(root, 'apply.lock');
  mkdirSync(root, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      linkSync(temp, path);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = lockHolder(path);
      if ((pid !== null && isAlive(pid)) || attempt > 0) {
        console.error(`nortuscc: another nortuscc run (pid ${pid ?? 'unknown'}) holds ${path}`);
        return 1;
      }
      rmSync(path, { force: true });
    } finally {
      rmSync(temp, { force: true });
    }
  }
  try {
    return await fn();
  } finally {
    if (lockHolder(path) === process.pid) rmSync(path, { force: true });
  }
}
```

- [ ] **Step 4: Run the lock tests**

Run: `node --test test/lock.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write the failing dispatch tests** — in `test/main.test.ts`, make every spawn self-contained and add two tests. Replace the `run` helper with one that points state at a temp dir (the dispatcher now takes a lock under `NORTUSCC_STATE_DIR`; without this a test would touch the developer's real `~/.config/nortuscc`):

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'nortuscc-main-'));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, NORTUSCC_STATE_DIR: stateDir } });

test('a legacy state writer is refused while another live run holds apply.lock', () => {
  mkdirSync(stateDir, { recursive: true });
  const lock = join(stateDir, 'apply.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    const result = run('push');
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`another nortuscc run \\(pid ${process.pid}\\) holds`));
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid);
  } finally {
    rmSync(lock, { force: true });
  }
});

test('a legacy state writer takes over a dead holder and releases the lock', () => {
  const lock = join(stateDir, 'apply.lock');
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: '2026-01-01T00:00:00.000Z' }));
  const result = run('push');
  assert.equal(result.status, 2); // push without -m is a usage error, reached only once the lock is held
  assert.equal(existsSync(lock), false);
});
```

(Add `rmSync` to the `node:fs` import. Confirm `push` with no `-m` exits 2 by reading `src/commands/push.mjs`; if not, use another `LOCKED` verb whose argument error exits 2 without side effects.)

- [ ] **Step 6: Run them to see the first fail**

Run: `node --test test/main.test.ts`
Expected: the "refused" test FAILS (exit 2, not 1).

- [ ] **Step 7: Wire `LOCKED` into both dispatch paths**

`bin/commands.mjs` — append:

```js
// Legacy verbs that read state.json and rewrite it whole. They hold <stateRoot>/apply.lock for
// the whole command; a ported verb takes it through @nortuscc/machine's executor instead.
export const LOCKED = ['apply', 'capture', 'pull', 'push', 'setup', 'uninstall'];
```

`src/main.ts`:

```ts
import { LOCKED, PORTED } from '../bin/commands.mjs';
import { withApplyLock } from './lock.mjs';

type Command = { run: (args: string[]) => Promise<number> };

// Routes a verb to its TypeScript port when one exists, else to the legacy module, which holds
// the apply lock when it rewrites state.json.
export async function main([verb, ...args]: string[]): Promise<number> {
  if (PORTED.includes(verb!)) {
    const module: Command = await import(`./commands/${verb}.ts`);
    return module.run(args);
  }
  const module: Command = await import(`./commands/${verb}.mjs`);
  return LOCKED.includes(verb!) ? withApplyLock(() => module.run(args)) : module.run(args);
}
```

`bin/nortuscc.mjs` legacy fallback (the `if (!PORTED.includes(verb))` block):

```js
if (!PORTED.includes(verb)) {
  const { run } = await import(`../src/commands/${verb}.mjs`);
  const { withApplyLock } = await import('../src/lock.mjs');
  process.exit(await (LOCKED.includes(verb) ? withApplyLock(() => run(rest)) : run(rest)));
}
```

and import `LOCKED` alongside `PORTED` from `./commands.mjs`. If `src/main.ts` fails typecheck importing `.mjs` without types, mirror how it already imports `../bin/commands.mjs`.

- [ ] **Step 8: Find other tests that spawn a `LOCKED` verb without `NORTUSCC_STATE_DIR`**

Run: `grep -ln "nortuscc.mjs" test/*.test.* | xargs grep -Ln NORTUSCC_STATE_DIR`
For each hit that runs `apply|capture|pull|push|setup|uninstall`, pass a temp `NORTUSCC_STATE_DIR` in its spawn env.

- [ ] **Step 9: Run the CLI suite and typecheck**

Run: `node --test test/main.test.ts test/lock.test.mjs && npm test && npm run typecheck && git status --short`
Expected: all pass (the README's known `fresh machine setup installs selected defaults for both agents` failure may persist; compare with `git stash`-free baseline by checking it fails identically on the base commit before calling it pre-existing). If `skills-manifest.txt` changed: `git checkout -- skills-manifest.txt`.

- [ ] **Step 10: Commit**

```bash
git add src/lock.mjs src/main.ts bin/commands.mjs bin/nortuscc.mjs test/lock.test.mjs test/main.test.ts <any spawn-env test fixes>
git commit -m "fix: make legacy state.json writers hold apply.lock"
```

---

### Task 2: Protocol v2

**Files:**
- Rewrite: `apps/desktop/backend/protocol.ts`
- Delete: `apps/desktop/backend/fixture.ts`, `apps/desktop/backend/operation.ts`, `apps/desktop/checks/fixture.spec.ts`
- Test: `apps/desktop/checks/protocol.spec.ts` (new)

**Interfaces:**
- Produces (all exported from `backend/protocol.ts`):
  - `PROTOCOL_VERSION = 2`, `MAX_RECORD_BYTES = 1_048_576`, `MAX_EXCLUDED = 10_000`, `MAX_KEY_LENGTH = 500`
  - `type ErrorCode = 'INVALID_REQUEST' | 'MALFORMED' | 'OVERSIZED' | 'SHUTDOWN' | 'BUSY' | 'NO_REPORT' | 'UNKNOWN_KEY' | 'UNKNOWN_PLAN' | 'PROFILE_INVALID' | 'REPO_NOT_FOUND' | 'INSPECT_FAILED' | 'INTERNAL'`
  - `type Request` = `{version:2,id,command:'inspect'|'cancel'|'shutdown'}` | `{…,command:'preview',exclude:string[]}` | `{…,command:'apply',planId:string}`
  - `type WireObserved`, `WireStep`, `WirePlan`, `WireIssue`, `Profile`, `InspectResult = { profile: Profile; items: WireObserved[]; probeErrors: string[] }`, `PreviewResult = { planId: string; plan: WirePlan }`, `ApplyResult = { status:'started'; runId } | { status:'stale'; planId; plan: WirePlan }`, `RunProgress` (machine `Progress` plus `{ type:'failed'; message }`), `RunEvent = { version:2; event:'progress'; runId; progress: RunProgress }`, `Response`
  - `decodeRequest`, `decodeMessage` (RunEvent | Response), `decodeInspectResult`, `decodePreviewResult`, `decodeApplyResult` — all `Schema.decodeUnknownSync(…, { onExcessProperty: 'error' })`

- [ ] **Step 1: Write the failing protocol tests** — `apps/desktop/checks/protocol.spec.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EXCLUDED, decodeApplyResult, decodeInspectResult, decodeMessage, decodeRequest,
} from '../backend/protocol.ts';

const step = { key: 'config:a', domain: 'config', action: 'write-file', summary: 'write a', touches: ['/x'], interruptible: false };

test('requests are the five v2 commands with only their own arguments', () => {
  assert.equal(decodeRequest({ version: 2, id: '1', command: 'inspect' }).command, 'inspect');
  assert.deepEqual(decodeRequest({ version: 2, id: '2', command: 'preview', exclude: ['k'] }), { version: 2, id: '2', command: 'preview', exclude: ['k'] });
  assert.equal(decodeRequest({ version: 2, id: '3', command: 'apply', planId: 'p' }).command, 'apply');
  for (const bad of [
    { version: 1, id: '1', command: 'inspect' },
    { version: 2, id: '1', command: 'start' },
    { version: 2, id: '1', command: 'crash' },
    { version: 2, id: '1', command: 'inspect', path: '/etc' },
    { version: 2, id: '1', command: 'preview', exclude: ['k'], cmd: 'rm' },
    { version: 2, id: '1', command: 'preview', exclude: [''] },
    { version: 2, id: '1', command: 'preview', exclude: ['x'.repeat(501)] },
    { version: 2, id: '1', command: 'preview', exclude: Array.from({ length: MAX_EXCLUDED + 1 }, (_, i) => `k${i}`) },
    { version: 2, id: '1', command: 'apply' },
    { version: 2, id: '', command: 'inspect' },
  ]) assert.throws(() => decodeRequest(bad), JSON.stringify(bad).slice(0, 80));
});

test('run events carry the machine progress vocabulary plus failed', () => {
  for (const progress of [
    { type: 'started', index: 0, total: 1, step },
    { type: 'finished', index: 0, total: 1, key: 'config:a', outcome: 'ok', note: '' },
    { type: 'done', ok: 1, failed: 0, backups: '/b' },
    { type: 'done', ok: 0, failed: 0 },
    { type: 'cancelled', remaining: ['config:b'] },
    { type: 'failed', message: 'another nortuscc run (pid 1) holds /s/apply.lock' },
  ]) assert.deepEqual(decodeMessage({ version: 2, event: 'progress', runId: 'r', progress }), { version: 2, event: 'progress', runId: 'r', progress });
  assert.throws(() => decodeMessage({ version: 2, event: 'progress', runId: 'r', progress: { type: 'exploded' } }));
  assert.throws(() => decodeMessage({ version: 1, event: 'progress', operationId: 'x', state: 'running', percent: 1, detail: '' }));
});

test('responses are v2 with a bounded error', () => {
  assert.equal(decodeMessage({ version: 2, id: '1', ok: true, result: { any: 1 } }).version, 2);
  assert.throws(() => decodeMessage({ version: 2, id: '1', ok: false, error: { code: 'X', message: 'm'.repeat(501) } }));
});

test('inspect and apply payloads decode strictly', () => {
  const inspected = decodeInspectResult({
    profile: { repo: '/r', revision: null, overrides: '/s/overrides.json', issues: [] },
    items: [{ key: 'config:a', domain: 'config', target: 'claude', label: 'a', group: 'Files', state: 'repo-ahead', disposition: 'apply', from: { layer: 'base', source: 'FILES' } }],
    probeErrors: ['claude was not found'],
  });
  assert.equal(inspected.items[0]!.disposition, 'apply');
  assert.throws(() => decodeInspectResult({ ...inspected, items: [{ ...inspected.items[0], extra: 1 }] }));
  assert.equal(decodeApplyResult({ status: 'stale', planId: 'p', plan: { kind: 'apply', steps: [step], skipped: [] } }).status, 'stale');
  assert.throws(() => decodeApplyResult({ status: 'started' }));
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd apps/desktop && npx tsx --test checks/protocol.spec.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Rewrite `apps/desktop/backend/protocol.ts`**

```ts
import { Schema } from 'effect';

// Protocol v2: JSON lines between the Rust host and the backend. The renderer reaches it only
// through Rust's allow-list, and every argument is an opaque key or id, never a path or command.
export const PROTOCOL_VERSION = 2;
export const MAX_RECORD_BYTES = 1_048_576;
export const MAX_EXCLUDED = 10_000;
export const MAX_KEY_LENGTH = 500;

export type ErrorCode =
  | 'INVALID_REQUEST' | 'MALFORMED' | 'OVERSIZED' | 'SHUTDOWN' | 'BUSY' | 'NO_REPORT' | 'UNKNOWN_KEY'
  | 'UNKNOWN_PLAN' | 'PROFILE_INVALID' | 'REPO_NOT_FOUND' | 'INSPECT_FAILED' | 'INTERNAL';

const Version = Schema.Literal(PROTOCOL_VERSION);
const Id = Schema.String.check(Schema.isBetweenLength(1, 100));
const Key = Schema.String.check(Schema.isBetweenLength(1, MAX_KEY_LENGTH));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const RequestSchema = Schema.Union([
  Schema.Struct({ version: Version, id: Id, command: Schema.Literals(['inspect', 'cancel', 'shutdown']) }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('preview'), exclude: Schema.Array(Key).check(Schema.isMaxLength(MAX_EXCLUDED)) }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('apply'), planId: Id }),
]);

const Domain = Schema.Literals(['config', 'integrations', 'skills']);
const Origin = Schema.Struct({ layer: Schema.Literals(['base', 'pin', 'machine']), source: Schema.String });

export const ObservedSchema = Schema.Struct({
  key: Schema.String,
  domain: Domain,
  target: Schema.Literals(['claude', 'codex']),
  label: Schema.String,
  group: Schema.String,
  state: Schema.String,
  disposition: Schema.Literals(['in-sync', 'apply', 'capture', 'blocked', 'excluded', 'undeclared']),
  note: Schema.optional(Schema.String),
  from: Schema.optional(Origin),
});
const IssueSchema = Schema.Struct({ layer: Schema.Literals(['base', 'pin', 'machine']), source: Schema.String, path: Schema.String, message: Schema.String });
const ProfileSchema = Schema.Struct({ repo: Schema.String, revision: Schema.NullOr(Schema.String), overrides: Schema.String, issues: Schema.Array(IssueSchema) });
export const InspectResultSchema = Schema.Struct({ profile: ProfileSchema, items: Schema.Array(ObservedSchema), probeErrors: Schema.Array(Schema.String) });

const StepSchema = Schema.Struct({
  key: Schema.String,
  domain: Domain,
  action: Schema.Literals(['write-file', 'merge-keys', 'restore', 'remove', 'capture-file', 'write-manifest', 'install-integration', 'install-skills']),
  summary: Schema.String,
  touches: Schema.Array(Schema.String),
  interruptible: Schema.Boolean,
});
const PlanSchema = Schema.Struct({
  kind: Schema.Literals(['apply', 'uninstall', 'capture']),
  steps: Schema.Array(StepSchema),
  skipped: Schema.Array(Schema.Struct({ key: Schema.String, reason: Schema.String })),
});
export const PreviewResultSchema = Schema.Struct({ planId: Id, plan: PlanSchema });
export const ApplyResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('started'), runId: Id }),
  // The machine changed since the preview: nothing ran, and this is the new preview.
  Schema.Struct({ status: Schema.Literal('stale'), planId: Id, plan: PlanSchema }),
]);

// @nortuscc/machine's Progress, plus `failed`: the run could not start or stopped on a defect.
const ProgressSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('started'), index: Count, total: Count, step: StepSchema }),
  Schema.Struct({ type: Schema.Literal('finished'), index: Count, total: Count, key: Schema.String, outcome: Schema.Literals(['ok', 'failed', 'cancelled']), note: Schema.String }),
  Schema.Struct({ type: Schema.Literal('done'), ok: Count, failed: Count, backups: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal('cancelled'), remaining: Schema.Array(Schema.String), backups: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal('failed'), message: Schema.String }),
]);
export const RunEventSchema = Schema.Struct({ version: Version, event: Schema.Literal('progress'), runId: Id, progress: ProgressSchema });

export const ResponseSchema = Schema.Union([
  Schema.Struct({ version: Version, id: Id, ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({ version: Version, id: Id, ok: Schema.Literal(false), error: Schema.Struct({ code: Id, message: Schema.String.check(Schema.isMaxLength(500)) }) }),
]);

const strict = { onExcessProperty: 'error' } as const;
export const decodeRequest = Schema.decodeUnknownSync(RequestSchema, strict);
export const decodeMessage = Schema.decodeUnknownSync(Schema.Union([RunEventSchema, ResponseSchema]), strict);
export const decodeInspectResult = Schema.decodeUnknownSync(InspectResultSchema, strict);
export const decodePreviewResult = Schema.decodeUnknownSync(PreviewResultSchema, strict);
export const decodeApplyResult = Schema.decodeUnknownSync(ApplyResultSchema, strict);

export type Request = typeof RequestSchema.Type;
export type WireObserved = typeof ObservedSchema.Type;
export type WireStep = typeof StepSchema.Type;
export type WirePlan = typeof PlanSchema.Type;
export type WireIssue = typeof IssueSchema.Type;
export type Profile = typeof ProfileSchema.Type;
export type InspectResult = typeof InspectResultSchema.Type;
export type PreviewResult = typeof PreviewResultSchema.Type;
export type ApplyResult = typeof ApplyResultSchema.Type;
export type RunProgress = typeof ProgressSchema.Type;
export type RunEvent = typeof RunEventSchema.Type;
export type Response = typeof ResponseSchema.Type;
```

If an Effect 4 check name differs (`isMaxLength` on arrays, `isGreaterThanOrEqualTo`), find the right one in `node_modules/effect/dist/Schema.d.ts` / `SchemaCheck` and keep the semantics.

- [ ] **Step 4: Delete the fixture backend**

```bash
git rm apps/desktop/backend/fixture.ts apps/desktop/backend/operation.ts apps/desktop/checks/fixture.spec.ts
```

- [ ] **Step 5: Run the protocol tests**

Run: `cd apps/desktop && npx tsx --test checks/protocol.spec.ts`
Expected: PASS. (`backend/main.ts`, `src/` and the other checks still reference fixture code; they are rewritten in Tasks 5 and 7.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/backend/protocol.ts apps/desktop/checks/protocol.spec.ts
git commit -m "feat: define desktop protocol v2 for inspect, preview and apply"
```

---

### Task 3: Login-shell PATH probe

**Files:**
- Create: `apps/desktop/backend/login-path.ts`
- Test: `apps/desktop/checks/login-path.spec.ts`

**Interfaces:**
- Produces: `type LoginPath = { readonly path: string; readonly error?: string }`;
  `probeLoginPath(input: { env: Readonly<Record<string, string | undefined>>; timeoutMs?: number }): Promise<LoginPath>` (never rejects; default timeout 5000 ms);
  `missingTools(tools: ReadonlyArray<string>, path: string): string[]` (one message per tool not executable on `path`);
  `DEFAULT_TOOLS = ['npx', 'claude', 'codex'] as const`.

- [ ] **Step 1: Write the failing tests** — `apps/desktop/checks/login-path.spec.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingTools, probeLoginPath } from '../backend/login-path.ts';

const dir = mkdtempSync(join(tmpdir(), 'nortuscc-login-path-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const script = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

test('reads PATH from between markers despite login banners', async () => {
  // Runs the probe's own script ($2) with a PATH a login rc file would set.
  const shell = script('noisy', 'echo "Welcome to your shell"\nPATH=/opt/tools/bin:/usr/bin\nexport PATH\n/bin/sh -c "$2"\necho "bye"');
  assert.deepEqual(await probeLoginPath({ env: { SHELL: shell, PATH: '/inherited' } }), { path: '/opt/tools/bin:/usr/bin' });
});

test('a hanging shell times out and falls back to the inherited PATH', async () => {
  const shell = script('hang', 'sleep 30');
  const started = Date.now();
  const result = await probeLoginPath({ env: { SHELL: shell, PATH: '/inherited' }, timeoutMs: 200 });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.path, '/inherited');
  assert.match(result.error!, /timed out/);
});

test('a missing shell falls back with a probe error', async () => {
  const result = await probeLoginPath({ env: { SHELL: join(dir, 'absent-shell'), PATH: '/inherited' } });
  assert.equal(result.path, '/inherited');
  assert.match(result.error!, /absent-shell/);
});

test('a shell that prints no PATH falls back', async () => {
  const shell = script('silent', 'exit 0');
  const result = await probeLoginPath({ env: { SHELL: shell, PATH: '/inherited' } });
  assert.equal(result.path, '/inherited');
  assert.match(result.error!, /no PATH/);
});

test('missingTools names each tool not executable on PATH', () => {
  const bin = mkdtempSync(join(dir, 'bin-'));
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\n');
  chmodSync(join(bin, 'npx'), 0o755);
  writeFileSync(join(bin, 'claude'), 'not executable');
  assert.deepEqual(missingTools(['npx', 'claude', 'codex'], `${bin}:/nonexistent`), [
    "'claude' was not found on the login shell's PATH",
    "'codex' was not found on the login shell's PATH",
  ]);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd apps/desktop && npx tsx --test checks/login-path.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `apps/desktop/backend/login-path.ts`**

```ts
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type LoginPath = { readonly path: string; readonly error?: string };
export const DEFAULT_TOOLS = ['npx', 'claude', 'codex'] as const;

const MARK = '__NORTUSCC_PATH__';
// Fixed: the shell runs only this, so rc-file output around the markers is ignored.
const SCRIPT = `printf '${MARK}%s${MARK}' "$PATH"`;

const capture = (shell: string, env: Readonly<Record<string, string | undefined>>, timeoutMs: number) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(shell, ['-ilc', SCRIPT], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let out = '';
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });

// Reads PATH once from the user's login shell, so installers resolve as they do in a terminal.
// Never rejects: on any failure it returns the inherited PATH with the reason as `error`.
export async function probeLoginPath(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}): Promise<LoginPath> {
  const fallback = input.env.PATH ?? '';
  const shell = input.env.SHELL && isAbsolute(input.env.SHELL) ? input.env.SHELL : '/bin/zsh';
  try {
    const out = await capture(shell, input.env, input.timeoutMs ?? 5000);
    const found = out.match(new RegExp(`${MARK}(.*?)${MARK}`, 's'))?.[1];
    if (found) return { path: found };
    return { path: fallback, error: `login shell ${shell} reported no PATH; using the app's PATH` };
  } catch (err) {
    return { path: fallback, error: `could not read PATH from login shell ${shell}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// One probe failure per tool that is not an executable file on `path`.
export const missingTools = (tools: ReadonlyArray<string>, path: string): string[] =>
  tools
    .filter((tool) => !path.split(':').some((dir) => dir !== '' && executable(join(dir, tool))))
    .map((tool) => `'${tool}' was not found on the login shell's PATH`);
```

Note: the `close` after a timeout's `reject` resolves an already-settled promise, which is harmless.

- [ ] **Step 4: Run the tests**

Run: `cd apps/desktop && npx tsx --test checks/login-path.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/backend/login-path.ts apps/desktop/checks/login-path.spec.ts
git commit -m "feat: read PATH from the login shell for the desktop backend"
```

---

### Task 4: Machine session (inspect, preview, apply with STALE, cancel)

**Files:**
- Create: `apps/desktop/backend/session.ts`, `apps/desktop/backend/domains.ts`
- Create: `apps/desktop/checks/support/fake-domains.ts`
- Modify: `apps/desktop/package.json` (dependencies), root `package-lock.json` (via `npm install`)
- Test: `apps/desktop/checks/session.spec.ts`

**Interfaces:**
- Consumes: Task 2 types (`InspectResult`, `PreviewResult`, `ApplyResult`, `RunProgress`, `WireObserved`, `WirePlan`, `ErrorCode`); Task 3 `LoginPath`, `missingTools`, `DEFAULT_TOOLS`; from `@nortuscc/machine`: `pathsFromEnvironment`, `machinePaths`, `nodeFs`, `nodeProcesses`, `stateStore`, `overridesStore`, `backupsForRun`, `inspect`, `plan`, `execute`, `samePlan`, `selectAll`, `RepoNotFound`, service tags `MachinePaths | Fs | Processes | StateStore | OverridesStore | Backups`, types `Domain`, `MachineReport`, `MachinePathsValue`, `Plan`, `PathsEnvironment`; from `@nortuscc/profile-engine`: `loadProfile`, `nodeFiles`.
- Produces:
  - `type DesktopServices = MachinePaths | Fs | Processes | StateStore | OverridesStore | Backups`
  - `class SessionError extends Error { readonly code: ErrorCode }`
  - `type SessionOptions = { environment: { env; home; platform }; loginPath: LoginPath; domains: ReadonlyArray<Domain<DesktopServices>>; tools?: ReadonlyArray<string> }`
  - `type Prepared = { readonly result: ApplyResult; readonly start?: (emit: (runId: string, progress: RunProgress) => void) => void }`
  - `class Session { constructor(options); get running(): boolean; inspect(): Promise<InspectResult>; preview(exclude: ReadonlyArray<string>): PreviewResult; apply(planId: string): Promise<Prepared>; cancel(): Promise<boolean> }`
  - `domains: ReadonlyArray<Domain<DesktopServices>>` from `backend/domains.ts` (empty)
  - `fakeDomain: Domain<DesktopServices>` and `writeFakeMachine(stateRoot, items: FakeItem[])` from `checks/support/fake-domains.ts`, with `type FakeItem = { key: string; disposition: Disposition; behavior?: 'slow' | 'sleepy' | 'fail' }`

Behavior contract (from the spec, decisions recorded here):
- `inspect`: throws `BUSY` during a run (or while `apply` prepares). Builds paths with no fallback; `RepoNotFound` → `REPO_NOT_FOUND` whose message is the error's message plus `Run 'nortuscc setup --dir <checkout>' in a terminal, then inspect again.` Reads overrides through `OverridesStore`, loads the profile with `nodeFiles`, runs `inspect(desired, domains)`, reads the revision with `git -C <repo> rev-parse HEAD` through `Processes` (any failure → `null`). Other failures → `INSPECT_FAILED`. Probe errors = login-path error, then `missingTools`, then the domains'. Stores the inspection and drops any preview. The wire report omits `desired`; it projects items to exactly the `WireObserved` fields.
- `preview(exclude)`: `BUSY`; `NO_REPORT` without an inspection; `PROFILE_INVALID` when `desired.issues` is non-empty (message: the first issue's `source: path — message` and the count); `UNKNOWN_KEY` naming the first key not in the last inspection; else dedupes, plans `'apply'` with `{ ...selectAll, exclude }`, stores it under a fresh `randomUUID()` plan id, returns it.
- `apply(planId)`: `BUSY`; `UNKNOWN_PLAN` unless `planId` is the stored preview's. Marks the session busy (cancel works from here on), re-inspects, re-checks `PROFILE_INVALID`, re-plans with the same exclusions. If `!samePlan(previewed, fresh)` → stores the fresh plan under a new id and returns `{ status: 'stale', planId, plan }` (busy cleared). Else consumes the preview and returns `{ status: 'started', runId }` with `start(emit)`: the caller sends the reply first, then calls `start`, so the reply always precedes the first event. `start` runs `execute(plan, report, domains, { signal })` with a fresh `backupsForRun()` layer, emitting each `Progress`; any failure (e.g. `LockHeld`) emits `{ type: 'failed', message }`. Busy clears when the run settles.
- `cancel()`: `false` when nothing is active; otherwise aborts and resolves `true` once the run has ended.

- [ ] **Step 1: Add the workspace dependencies**

In `apps/desktop/package.json` `dependencies`, add `"@nortuscc/machine": "0.1.0"` and `"@nortuscc/profile-engine": "0.1.0"`. Then run `npm install` at the repo root and confirm `git diff --stat package-lock.json` shows only the workspace link entries.

- [ ] **Step 2: Write the fake domain** — `apps/desktop/checks/support/fake-domains.ts`:

```ts
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Effect } from 'effect';
import { Backups, Fs, MachinePaths, type Disposition, type Domain, type Observed } from '@nortuscc/machine';
import type { DesktopServices } from '../../backend/session.ts';

// A test machine described by <stateRoot>/fake-machine.json. `slow` steps are interruptible and
// never finish; `sleepy` steps are file-like units that take 300 ms; `fail` steps fail.
export type FakeItem = { key: string; disposition: Disposition; behavior?: 'slow' | 'sleepy' | 'fail' };

const machineFile = (stateRoot: string) => join(stateRoot, 'fake-machine.json');
export const appliedFile = (stateRoot: string, key: string) => join(stateRoot, 'applied', encodeURIComponent(key));

export const writeFakeMachine = (stateRoot: string, items: ReadonlyArray<FakeItem>) => {
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(machineFile(stateRoot), JSON.stringify({ items }));
};

const readItems = Effect.gen(function* () {
  const { stateRoot } = yield* MachinePaths;
  const text = yield* (yield* Fs).readText(machineFile(stateRoot));
  return text === undefined ? [] : (JSON.parse(text).items as FakeItem[]);
});

export const fakeDomain: Domain<DesktopServices> = {
  name: 'config',
  inspect: () =>
    readItems.pipe(
      Effect.map((items) => ({
        items: items.map((item): Observed => ({
          key: item.key,
          domain: 'config',
          target: 'claude',
          label: item.key,
          group: 'Fake files',
          state: item.disposition === 'in-sync' ? 'clean' : 'repo-ahead',
          disposition: item.disposition,
          from: { layer: 'base', source: 'fake' },
          ...(item.behavior ? { note: item.behavior } : {}),
        })),
        probeErrors: [],
      })),
      Effect.orElseSucceed(() => ({ items: [], probeErrors: ['fake machine unreadable'] })),
    ),
  steps: (items) => ({
    steps: items.filter((i) => i.disposition === 'apply').map((i) => ({
      key: i.key, domain: 'config' as const, action: 'write-file' as const, summary: `write ${i.key}`, touches: [i.key], interruptible: i.note === 'slow',
    })),
    skipped: items.filter((i) => i.disposition === 'blocked').map((i) => ({ key: i.key, reason: 'blocked' })),
  }),
  run: (step, report) =>
    Effect.gen(function* () {
      const note = report.items.find((i) => i.key === step.key)?.note;
      if (note === 'slow') return yield* Effect.never;
      if (note === 'fail') return yield* Effect.fail(new Error(`fake failure for ${step.key}`));
      if (note === 'sleepy') yield* Effect.sleep('300 millis');
      const { stateRoot } = yield* MachinePaths;
      const fs = yield* Fs;
      const target = appliedFile(stateRoot, step.key);
      yield* (yield* Backups).preserve(target, encodeURIComponent(step.key));
      yield* fs.writeTextAtomic(target, 'applied\n');
      const items = (yield* readItems).map((i) => (i.key === step.key ? { ...i, disposition: 'in-sync' as const } : i));
      yield* fs.writeTextAtomic(machineFile(stateRoot), JSON.stringify({ items }));
      return { ok: true };
    }),
};
```

- [ ] **Step 3: Write the failing session tests** — `apps/desktop/checks/session.spec.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decodeInspectResult, decodePreviewResult, type RunProgress } from '../backend/protocol.ts';
import { Session, SessionError } from '../backend/session.ts';
import { appliedFile, fakeDomain, writeFakeMachine, type FakeItem } from './support/fake-domains.ts';

const checkout = resolve(import.meta.dirname, '../../..');

// A machine under a temporary HOME whose state.json records this checkout.
function machine(t: test.TestContext, items: FakeItem[], record: string | null = checkout) {
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

async function run(session: Session, planId: string) {
  const prepared = await session.apply(planId);
  assert.equal(prepared.result.status, 'started');
  const events: RunProgress[] = [];
  const ended = new Promise<void>((done) =>
    prepared.start!((_, progress) => {
      events.push(progress);
      if (['done', 'cancelled', 'failed'].includes(progress.type)) done();
    }));
  return { events, ended };
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
  const { events, ended } = await run(session, session.preview([]).planId);
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
  const { events, ended } = await run(session, session.preview([]).planId);
  await assert.rejects(session.inspect(), code('BUSY'));
  assert.throws(() => session.preview([]), code('BUSY'));
  assert.equal(await session.cancel(), true);
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
```

- [ ] **Step 4: Run to see it fail**

Run: `cd apps/desktop && npx tsx --test checks/session.spec.ts`
Expected: FAIL (`backend/session.ts` missing).

- [ ] **Step 5: Implement `apps/desktop/backend/session.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Cause, Effect, Exit, Layer, Stream } from 'effect';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import {
  Backups, Fs, MachinePaths, OverridesStore, Processes, RepoNotFound, StateStore,
  backupsForRun, execute, inspect, machinePaths, nodeFs, nodeProcesses, overridesStore, pathsFromEnvironment, plan,
  samePlan, selectAll, stateStore,
  type Domain, type MachinePathsValue, type MachineReport, type PathsEnvironment, type Plan, type Progress,
} from '@nortuscc/machine';
import { DEFAULT_TOOLS, missingTools, type LoginPath } from './login-path.ts';
import type { ApplyResult, ErrorCode, InspectResult, PreviewResult, RunProgress, WireObserved, WirePlan } from './protocol.ts';

export type DesktopServices = MachinePaths | Fs | Processes | StateStore | OverridesStore | Backups;

// A refusal the renderer can act on; `code` travels as the protocol's error code.
export class SessionError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

export type SessionOptions = {
  readonly environment: Pick<PathsEnvironment, 'env' | 'home' | 'platform'>;
  readonly loginPath: LoginPath;
  readonly domains: ReadonlyArray<Domain<DesktopServices>>;
  readonly tools?: ReadonlyArray<string>;
};

export type Prepared = {
  readonly result: ApplyResult;
  // Present when the run was accepted. Call it after replying, so the reply precedes every event.
  readonly start?: (emit: (runId: string, progress: RunProgress) => void) => void;
};

type Inspection = { readonly paths: MachinePathsValue; readonly report: MachineReport; readonly result: InspectResult };
type Previewed = { readonly planId: string; readonly exclude: ReadonlyArray<string>; readonly plan: Plan };

const describe = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && '_tag' in error && typeof error._tag === 'string') return error._tag;
  return String(error);
};

const settle = async <A>(effect: Effect.Effect<A, unknown>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

// Every service a domain may need, built for one machine; a fresh Backups folder per call.
const services = (paths: MachinePathsValue, path: string) =>
  Layer.mergeAll(stateStore, overridesStore, backupsForRun()).pipe(
    Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs, nodeProcesses({ path }))),
  );

const wireItem = (item: MachineReport['items'][number]): WireObserved => ({
  key: item.key, domain: item.domain, target: item.target, label: item.label, group: item.group, state: item.state,
  disposition: item.disposition,
  ...(item.note === undefined ? {} : { note: item.note }),
  ...(item.from === undefined ? {} : { from: { layer: item.from.layer, source: item.from.source } }),
});

const wireStep = (step: Plan['steps'][number]) => ({
  key: step.key, domain: step.domain, action: step.action, summary: step.summary, touches: [...step.touches], interruptible: step.interruptible,
});

const wirePlan = (p: Plan): WirePlan => ({
  kind: p.kind, steps: p.steps.map(wireStep), skipped: p.skipped.map((s) => ({ key: s.key, reason: s.reason })),
});

const wireProgress = (progress: Progress): RunProgress =>
  progress.type === 'started' ? { ...progress, step: wireStep(progress.step) } : progress;

// The backend's one machine: the last inspection, the last preview, and at most one run.
export class Session {
  private inspection?: Inspection;
  private previewed?: Previewed;
  private active?: { readonly abort: AbortController; readonly done: Promise<void> };

  constructor(private readonly options: SessionOptions) {}

  get running(): boolean {
    return this.active !== undefined;
  }

  async inspect(): Promise<InspectResult> {
    this.idle();
    const inspection = await this.observe();
    this.inspection = inspection;
    this.previewed = undefined;
    return inspection.result;
  }

  preview(exclude: ReadonlyArray<string>): PreviewResult {
    this.idle();
    const inspection = this.inspection;
    if (!inspection) throw new SessionError('NO_REPORT', 'Inspect the machine before previewing');
    this.valid(inspection);
    const keys = new Set(inspection.report.items.map((item) => item.key));
    const unknown = exclude.find((key) => !keys.has(key));
    if (unknown !== undefined) throw new SessionError('UNKNOWN_KEY', `'${unknown}' is not an item of the last inspection`);
    const unique = [...new Set(exclude)];
    this.previewed = { planId: randomUUID(), exclude: unique, plan: this.plan(inspection, unique) };
    return { planId: this.previewed.planId, plan: wirePlan(this.previewed.plan) };
  }

  async apply(planId: string): Promise<Prepared> {
    this.idle();
    const previewed = this.previewed;
    if (!previewed || previewed.planId !== planId) throw new SessionError('UNKNOWN_PLAN', 'That preview is no longer current; preview again');
    const abort = new AbortController();
    let finish!: () => void;
    this.active = { abort, done: new Promise<void>((resolve) => { finish = resolve; }) };
    const release = () => {
      this.active = undefined;
      finish();
    };
    try {
      const inspection = await this.observe();
      this.inspection = inspection;
      this.valid(inspection);
      const fresh = this.plan(inspection, previewed.exclude);
      if (!samePlan(previewed.plan, fresh)) {
        this.previewed = { planId: randomUUID(), exclude: previewed.exclude, plan: fresh };
        release();
        return { result: { status: 'stale', planId: this.previewed.planId, plan: wirePlan(fresh) } };
      }
      this.previewed = undefined;
      const runId = randomUUID();
      return {
        result: { status: 'started', runId },
        start: (emit) => {
          void this.execute(inspection, fresh, abort.signal, (progress) => emit(runId, progress)).finally(release);
        },
      };
    } catch (err) {
      release();
      throw err;
    }
  }

  async cancel(): Promise<boolean> {
    const active = this.active;
    if (!active) return false;
    active.abort.abort();
    await active.done;
    return true;
  }

  private idle() {
    if (this.active) throw new SessionError('BUSY', 'An apply is running');
  }

  private valid(inspection: Inspection) {
    const issues = inspection.report.desired.issues;
    if (issues.length) {
      const first = issues[0]!;
      throw new SessionError('PROFILE_INVALID', `The profile has ${issues.length} issue(s); first: ${first.source}: ${first.path} — ${first.message}`);
    }
  }

  private plan(inspection: Inspection, exclude: ReadonlyArray<string>): Plan {
    return plan('apply', inspection.report, { ...selectAll, exclude }, this.options.domains);
  }

  private async observe(): Promise<Inspection> {
    const { domains, loginPath } = this.options;
    const paths = await settle(pathsFromEnvironment(this.options.environment)).catch((err: unknown) => {
      if (err instanceof RepoNotFound) {
        throw new SessionError('REPO_NOT_FOUND', `${err.message}. Run 'nortuscc setup --dir <checkout>' in a terminal, then inspect again.`);
      }
      throw new SessionError('INSPECT_FAILED', describe(err));
    });
    const observed = await settle(
      Effect.gen(function* () {
        const overrides = yield* (yield* OverridesStore).read;
        const desired = yield* Effect.provide(loadProfile(paths.repo, { overrides }), nodeFiles);
        const report = yield* inspect(desired, domains);
        const head = yield* Effect.exit((yield* Processes).run({ cmd: 'git', args: ['-C', paths.repo, 'rev-parse', 'HEAD'], output: 'capture' }));
        const revision = Exit.isSuccess(head) && head.value.code === 0 ? head.value.stdout.trim() || null : null;
        return { report, revision };
      }).pipe(Effect.provide(services(paths, loginPath.path))),
    ).catch((err: unknown) => {
      throw new SessionError('INSPECT_FAILED', describe(err));
    });
    const { report, revision } = observed;
    return {
      paths,
      report,
      result: {
        profile: {
          repo: paths.repo,
          revision,
          overrides: join(paths.stateRoot, 'overrides.json'),
          issues: report.desired.issues.map((i) => ({ layer: i.layer, source: i.source, path: i.path, message: i.message })),
        },
        items: report.items.map(wireItem),
        probeErrors: [
          ...(loginPath.error ? [loginPath.error] : []),
          ...missingTools(this.options.tools ?? DEFAULT_TOOLS, loginPath.path),
          ...report.probeErrors,
        ],
      },
    };
  }

  private async execute(inspection: Inspection, p: Plan, signal: AbortSignal, emit: (progress: RunProgress) => void) {
    const exit = await Effect.runPromiseExit(
      execute(p, inspection.report, this.options.domains, { signal }).pipe(
        Stream.runForEach((progress) => Effect.sync(() => emit(wireProgress(progress)))),
        Effect.provide(services(inspection.paths, this.options.loginPath.path)),
      ),
    );
    if (Exit.isFailure(exit)) emit({ type: 'failed', message: describe(Cause.squash(exit.cause)) });
  }
}
```

`apps/desktop/backend/domains.ts`:

```ts
import type { Domain } from '@nortuscc/machine';
import type { DesktopServices } from './session.ts';

// The domains this build inspects and applies, in run order. Config (#55), integrations (#56)
// and skills (#57) join here as they merge; until then a real inspect reports no items.
export const domains: ReadonlyArray<Domain<DesktopServices>> = [];
```

If `RepoNotFound`'s `instanceof` check fails across the Effect boundary, match on `(err as { _tag?: string })._tag === 'RepoNotFound'` instead. If `Effect.provide(services(...))` leaves a requirement unsatisfied in the type, check the exact `Layer.provideMerge` argument order in `node_modules/effect` and fix it; do not widen types with `any`.

- [ ] **Step 6: Run the session tests**

Run: `cd apps/desktop && npx tsx --test checks/session.spec.ts`
Expected: PASS. If the profile-issues test's override does not produce an issue, read `packages/profile-engine/src/resolve.ts` and pick an override that does (an undeclared skill name is one).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck -w apps/desktop`
Expected: errors only in `src/`, `checks/controller.spec.ts`, `checks/backend.spec.ts` and `backend/main.ts` (rewritten in Tasks 5 and 7). None in `backend/session.ts`, `backend/domains.ts`, `backend/login-path.ts`, `backend/protocol.ts` or `checks/support/`.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/package.json package-lock.json apps/desktop/backend/session.ts apps/desktop/backend/domains.ts apps/desktop/checks/support/fake-domains.ts apps/desktop/checks/session.spec.ts
git commit -m "feat: add the desktop machine session with stale-plan refusal"
```

---

### Task 5: stdio server, entry point and bundling

**Files:**
- Create: `apps/desktop/backend/server.ts`, `apps/desktop/checks/support/fake-backend.ts`
- Rewrite: `apps/desktop/backend/main.ts`, `apps/desktop/checks/backend.spec.ts`
- Modify: `apps/desktop/scripts/bundle.mjs` (Effect license lookup), `apps/desktop/package.json` (`test:bun` script)

**Interfaces:**
- Consumes: `Session`, `SessionError`, `DesktopServices` (Task 4); `probeLoginPath` (Task 3); `decodeRequest`, `decodeMessage`, `MAX_RECORD_BYTES`, `PROTOCOL_VERSION`, `RunProgress`, `ErrorCode` (Task 2); `domains` (Task 4).
- Produces: `serve(session: Session): void` (owns process stdin/stdout, exits the process on shutdown/EOF/SIGTERM/SIGINT); `startBackend(domains, options?: { tools?: ReadonlyArray<string> }): Promise<void>`.

Server contract:
- Framing as the fixture did, at `MAX_RECORD_BYTES`. Oversized input → `OVERSIZED` "Record exceeds 1048576 bytes"; bad JSON → `MALFORMED`; schema failure → `INVALID_REQUEST` (id echoed when it is a 1–100 char string, else `invalid`); request after shutdown began → `SHUTDOWN`.
- Every outgoing record is checked with `decodeMessage` and its encoded length; a result over the limit becomes `OVERSIZED` "Result exceeds 1048576 bytes" for that id.
- `inspect` → `session.inspect()`; `preview` → `session.preview(exclude)`; `apply` → reply `prepared.result`, then `prepared.start?.(emitRun)`; `cancel` → `{ cancelled: boolean }`; `shutdown` → cancel, reply `{ shutdown: true }`, exit 0. EOF/SIGTERM/SIGINT → cancel, exit 0. `SessionError` → its code; anything else → `INTERNAL` with the message, truncated to 500 characters.

- [ ] **Step 1: Write the fake entry** — `apps/desktop/checks/support/fake-backend.ts`:

```ts
import { startBackend } from '../../backend/server.ts';
import { fakeDomain } from './fake-domains.ts';

// The real server and session over the fake domain, for stdio tests.
await startBackend([fakeDomain], { tools: [] });
```

- [ ] **Step 2: Write the failing stdio tests** — replace `apps/desktop/checks/backend.spec.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { MAX_RECORD_BYTES } from '../backend/protocol.ts';
import { appliedFile, writeFakeMachine, type FakeItem } from './support/fake-domains.ts';

// DESKTOP_RUNTIME runs the backend sources on another runtime, such as the bundled Bun.
const runtime = process.env.DESKTOP_RUNTIME;
const checkout = resolve(import.meta.dirname, '../../..');

// A temporary HOME whose state.json records this checkout, and a shell that runs the probe directly.
function home(t: test.TestContext, items: FakeItem[] = [], record: string | null = checkout) {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-backend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateRoot = join(dir, '.config', 'nortuscc');
  mkdirSync(stateRoot, { recursive: true });
  if (record !== null) writeFileSync(join(stateRoot, 'state.json'), JSON.stringify({ version: 1, repo: record, skillsOnly: false, files: {} }));
  writeFakeMachine(stateRoot, items);
  const shell = join(dir, 'shell');
  writeFileSync(shell, '#!/bin/sh\nexec /bin/sh -c "$2"\n');
  chmodSync(shell, 0o755);
  return { dir, stateRoot, env: { PATH: process.env.PATH ?? '', HOME: dir, SHELL: shell } };
}

function client(t: test.TestContext, env: Record<string, string>, entry = 'checks/support/fake-backend.ts', command?: string, args?: string[], cwd = resolve('.')) {
  const child = spawn(command ?? runtime ?? process.execPath, args ?? (runtime ? [entry] : ['--import', 'tsx', entry]), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages: any[] = [];
  const stderr: string[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
  createInterface({ input: child.stderr }).on('line', (line) => stderr.push(line));
  let id = 0;
  async function until<T>(get: () => T | undefined, ms = 10_000): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const value = get();
      if (value !== undefined) return value;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`Timed out; messages=${JSON.stringify(messages).slice(0, 2000)} stderr=${stderr.join('\n').slice(0, 2000)}`);
  }
  const send = (command: string, extra: Record<string, unknown> = {}) => {
    const requestId = String(++id);
    child.stdin.write(JSON.stringify({ version: 2, id: requestId, command, ...extra }) + '\n');
    return until(() => messages.find((m) => m.id === requestId));
  };
  const terminal = (runId: string) => until(() => messages.find((m) => m.runId === runId && ['done', 'cancelled', 'failed'].includes(m.progress.type)));
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.stdin.end();
      await exited;
    }
  };
  t.after(close);
  return { child, messages, stderr, send, terminal, until, close };
}

test('the real entry inspects and previews this checkout on a temporary HOME', async (t) => {
  const h = home(t);
  const c = client(t, h.env, 'backend/main.ts');
  const inspected = await c.send('inspect');
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.result.profile.repo, checkout);
  assert.ok(Array.isArray(inspected.result.items));
  const preview = await c.send('preview', { exclude: [] });
  assert.equal(preview.ok, true);
  assert.equal(preview.result.plan.kind, 'apply');
});

test('the real entry names a stale recorded checkout', async (t) => {
  const c = client(t, home(t, [], '/nonexistent/claude-config').env, 'backend/main.ts');
  const reply = await c.send('inspect');
  assert.equal(reply.error.code, 'REPO_NOT_FOUND');
  assert.match(reply.error.message, /\/nonexistent\/claude-config.*nortuscc setup --dir/);
});

test('apply replies before its events and runs the plan to done', async (t) => {
  const h = home(t, [{ key: 'config:a', disposition: 'apply' }, { key: 'config:b', disposition: 'apply' }]);
  const c = client(t, h.env);
  await c.send('inspect');
  const preview = await c.send('preview', { exclude: [] });
  const applied = await c.send('apply', { planId: preview.result.planId });
  assert.equal(applied.result.status, 'started');
  const done = await c.terminal(applied.result.runId);
  assert.equal(done.progress.type, 'done');
  const run = c.messages.filter((m) => m.runId === applied.result.runId).map((m) => m.progress.type);
  assert.deepEqual(run, ['started', 'finished', 'started', 'finished', 'done']);
  assert.ok(c.messages.indexOf(applied) < c.messages.findIndex((m) => m.runId === applied.result.runId));
  assert.equal(readFileSync(appliedFile(h.stateRoot, 'config:b'), 'utf8'), 'applied\n');
  assert.ok((await c.send('inspect')).result.items.every((i: any) => i.disposition === 'in-sync'));
});

test('busy rejection, cancel, and a released lock', async (t) => {
  const h = home(t, [{ key: 'config:slow', disposition: 'apply', behavior: 'slow' }, { key: 'config:b', disposition: 'apply' }]);
  const c = client(t, h.env);
  await c.send('inspect');
  const applied = await c.send('apply', { planId: (await c.send('preview', { exclude: [] })).result.planId });
  await c.until(() => c.messages.find((m) => m.runId === applied.result.runId && m.progress.type === 'started'));
  assert.equal((await c.send('inspect')).error.code, 'BUSY');
  assert.equal((await c.send('apply', { planId: 'x' })).error.code, 'BUSY');
  assert.deepEqual((await c.send('cancel')).result, { cancelled: true });
  const end = await c.terminal(applied.result.runId);
  assert.deepEqual(end.progress, { type: 'cancelled', remaining: ['config:b'] });
  assert.equal(existsSync(join(h.stateRoot, 'apply.lock')), false);
});

test('a stale preview is refused with the new preview', async (t) => {
  const h = home(t, [{ key: 'config:a', disposition: 'apply' }]);
  const c = client(t, h.env);
  await c.send('inspect');
  const first = await c.send('preview', { exclude: [] });
  writeFakeMachine(h.stateRoot, [{ key: 'config:a', disposition: 'apply' }, { key: 'config:new', disposition: 'apply' }]);
  const stale = await c.send('apply', { planId: first.result.planId });
  assert.equal(stale.result.status, 'stale');
  assert.deepEqual(stale.result.plan.steps.map((s: any) => s.key), ['config:a', 'config:new']);
  assert.equal(c.messages.some((m) => m.event === 'progress'), false);
  assert.equal((await c.send('apply', { planId: first.result.planId })).error.code, 'UNKNOWN_PLAN');
  assert.equal((await c.send('preview', { exclude: ['config:nope'] })).error.code, 'UNKNOWN_KEY');
});

test('shutdown and EOF mid-apply finish the current file step and release the lock', async (t) => {
  for (const mode of ['shutdown', 'eof'] as const) {
    const h = home(t, [{ key: 'config:sleepy', disposition: 'apply', behavior: 'sleepy' }, { key: 'config:b', disposition: 'apply' }]);
    const c = client(t, h.env);
    await c.send('inspect');
    const applied = await c.send('apply', { planId: (await c.send('preview', { exclude: [] })).result.planId });
    await c.until(() => c.messages.find((m) => m.runId === applied.result.runId && m.progress.type === 'started'));
    const exited = once(c.child, 'exit');
    if (mode === 'shutdown') c.child.stdin.write(JSON.stringify({ version: 2, id: 'bye', command: 'shutdown' }) + '\n');
    else c.child.stdin.end();
    assert.equal((await exited)[0], 0, mode);
    assert.equal(readFileSync(appliedFile(h.stateRoot, 'config:sleepy'), 'utf8'), 'applied\n', mode);
    assert.equal(existsSync(appliedFile(h.stateRoot, 'config:b')), false, mode);
    assert.equal(existsSync(join(h.stateRoot, 'apply.lock')), false, mode);
  }
});

test('an abruptly killed backend leaves a lock the next run takes over', async (t) => {
  const h = home(t, [{ key: 'config:slow', disposition: 'apply', behavior: 'slow' }]);
  const first = client(t, h.env);
  await first.send('inspect');
  const applied = await first.send('apply', { planId: (await first.send('preview', { exclude: [] })).result.planId });
  await first.until(() => first.messages.find((m) => m.runId === applied.result.runId && m.progress.type === 'started'));
  const exited = once(first.child, 'exit');
  first.child.kill('SIGKILL');
  await exited;
  assert.equal(existsSync(join(h.stateRoot, 'apply.lock')), true);
  writeFakeMachine(h.stateRoot, [{ key: 'config:a', disposition: 'apply' }]);
  const second = client(t, h.env);
  await second.send('inspect');
  const again = await second.send('apply', { planId: (await second.send('preview', { exclude: [] })).result.planId });
  assert.equal((await second.terminal(again.result.runId)).progress.type, 'done');
});

test('a report far above the old 16 KB cap round-trips', async (t) => {
  const items = Array.from({ length: 2000 }, (_, i) => ({ key: `config:item-${i}`, disposition: 'in-sync' as const }));
  const c = client(t, home(t, items).env);
  const inspected = await c.send('inspect');
  assert.equal(inspected.result.items.length, 2000);
  assert.ok(JSON.stringify(inspected).length > 16_384);
});

test('malformed, oversized, v1, unknown and path-carrying records are rejected; the next request works', async (t) => {
  const c = client(t, home(t).env);
  c.child.stdin.write('{broken\n' + 'x'.repeat(MAX_RECORD_BYTES + 1) + '\n');
  c.child.stdin.write(JSON.stringify({ version: 1, id: 'v1', command: 'inspect' }) + '\n');
  c.child.stdin.write(JSON.stringify({ version: 2, id: 'crash', command: 'crash' }) + '\n');
  c.child.stdin.write(JSON.stringify({ version: 2, id: 'path', command: 'inspect', path: '/etc' }) + '\n');
  assert.equal((await c.send('inspect')).ok, true);
  const failures = await c.until(() => (c.messages.filter((m) => m.ok === false).length === 5 ? c.messages.filter((m) => m.ok === false) : undefined));
  assert.deepEqual(failures.map((m) => m.error.code).sort(), ['INVALID_REQUEST', 'INVALID_REQUEST', 'INVALID_REQUEST', 'MALFORMED', 'OVERSIZED']);
});

test('the bundled Bun backend runs from another directory with an empty PATH', async (t) => {
  const root = resolve('src-tauri/resources', `${process.platform}-${process.arch}`);
  const h = home(t);
  const cwd = mkdtempSync(join(tmpdir(), 'nortuscc-bundled-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const c = client(t, { PATH: '', HOME: h.dir }, undefined, join(root, 'bun'), [join(root, 'backend.mjs')], cwd);
  const inspected = await c.send('inspect');
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.result.profile.repo, checkout);
});
```

- [ ] **Step 3: Run to see it fail**

Run: `cd apps/desktop && npx tsx --test checks/backend.spec.ts`
Expected: FAIL (`backend/server.ts` missing).

- [ ] **Step 4: Implement `apps/desktop/backend/server.ts`**

```ts
import { homedir } from 'node:os';
import type { Domain } from '@nortuscc/machine';
import { probeLoginPath } from './login-path.ts';
import { MAX_RECORD_BYTES, PROTOCOL_VERSION, decodeMessage, decodeRequest, type ErrorCode, type RunProgress } from './protocol.ts';
import { Session, SessionError, type DesktopServices } from './session.ts';

const write = (message: unknown) => {
  const line = JSON.stringify(decodeMessage(message)) + '\n';
  process.stdout.write(line);
  return line;
};

// Serves protocol v2 on stdin/stdout for one session until shutdown, EOF or a signal.
export function serve(session: Session): void {
  let closing = false;
  const reject = (id: string, code: ErrorCode, message: string) =>
    write({ version: PROTOCOL_VERSION, id, ok: false, error: { code, message: message.slice(0, 500) } });
  const reply = (id: string, result: unknown) => {
    const line = JSON.stringify({ version: PROTOCOL_VERSION, id, ok: true, result });
    if (Buffer.byteLength(line) + 1 > MAX_RECORD_BYTES) return reject(id, 'OVERSIZED', `Result exceeds ${MAX_RECORD_BYTES} bytes`);
    write(JSON.parse(line));
  };
  const emitRun = (runId: string, progress: RunProgress) =>
    write({ version: PROTOCOL_VERSION, event: 'progress', runId, progress });
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await session.cancel();
    process.exit(0);
  };

  async function handle(raw: unknown) {
    let request;
    try {
      request = decodeRequest(raw);
    } catch {
      const id = typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 100 ? raw.id : 'invalid';
      reject(id, 'INVALID_REQUEST', 'Invalid protocol version, command or arguments');
      return;
    }
    if (closing) return reject(request.id, 'SHUTDOWN', 'Backend is shutting down');
    try {
      switch (request.command) {
        case 'inspect':
          return reply(request.id, await session.inspect());
        case 'preview':
          return reply(request.id, session.preview(request.exclude));
        case 'apply': {
          const prepared = await session.apply(request.planId);
          reply(request.id, prepared.result);
          prepared.start?.(emitRun);
          return;
        }
        case 'cancel':
          return reply(request.id, { cancelled: await session.cancel() });
        case 'shutdown':
          closing = true;
          await session.cancel();
          reply(request.id, { shutdown: true });
          process.exit(0);
      }
    } catch (err) {
      if (err instanceof SessionError) reject(request.id, err.code, err.message);
      else reject(request.id, 'INTERNAL', err instanceof Error ? err.message : String(err));
    }
  }

  let buffer = Buffer.alloc(0);
  let oversized = false;
  process.stdin.on('data', (chunk: Buffer) => {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (!oversized && buffer.length + part.length <= MAX_RECORD_BYTES) buffer = Buffer.concat([buffer, part]);
      else {
        oversized = true;
        buffer = Buffer.alloc(0);
      }
      if (newline < 0) break;
      if (oversized) reject('invalid', 'OVERSIZED', `Record exceeds ${MAX_RECORD_BYTES} bytes`);
      else {
        try {
          void handle(JSON.parse(buffer.toString('utf8'))).catch(() => reject('invalid', 'INTERNAL', 'Request failed'));
        } catch {
          reject('invalid', 'MALFORMED', 'Expected a JSON record');
        }
      }
      buffer = Buffer.alloc(0);
      oversized = false;
      offset = newline + 1;
    }
  });
  process.stdin.on('end', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Reads the login PATH once, then serves a session over `domains` for this user's machine.
export async function startBackend(
  domains: ReadonlyArray<Domain<DesktopServices>>,
  options: { readonly tools?: ReadonlyArray<string> } = {},
): Promise<void> {
  const loginPath = await probeLoginPath({ env: process.env });
  serve(new Session({
    environment: { env: process.env, home: homedir(), platform: process.platform },
    loginPath,
    domains,
    ...(options.tools ? { tools: options.tools } : {}),
  }));
}
```

`apps/desktop/backend/main.ts`:

```ts
import { domains } from './domains.ts';
import { startBackend } from './server.ts';

// The desktop backend: one session over this user's machine, served to the Rust host on stdio.
await startBackend(domains);
```

- [ ] **Step 5: Fix bundling** — in `apps/desktop/scripts/bundle.mjs`, the Effect license is hoisted to the root `node_modules`. Replace the `EFFECT-LICENSE` copy with:

```js
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
// …
const effectRoot = dirname(createRequire(import.meta.url).resolve('effect/package.json'));
await copyFile(resolve(effectRoot, 'LICENSE'), resolve(resources, 'EFFECT-LICENSE'));
```

(If `effect`'s `exports` hides `package.json`, resolve `effect` and walk up to the directory containing `LICENSE`.) Then build resources:

```bash
export DESKTOP_BUN_LICENSE=~/.cache/nortuscc/bun-LICENSE.md   # see Global Constraints
npm run resources -w apps/desktop
```

Expected: "Bundled backend and Bun 1.3.14 for darwin-arm64".

- [ ] **Step 6: Update `test:bun`** in `apps/desktop/package.json`:

```json
"test:bun": "bun test ./checks/protocol.spec.ts ./checks/controller.spec.ts && DESKTOP_RUNTIME=\"$PWD/src-tauri/resources/darwin-arm64/bun\" tsx --test checks/backend.spec.ts",
```

- [ ] **Step 7: Run the stdio tests**

Run: `cd apps/desktop && npx tsx --test checks/backend.spec.ts`
Expected: PASS, and the process exits normally. The fixture-era spec aborted at teardown on Node 24.19.0 after its subtests passed. If this file shows the same `'test failed'` at file level with passing subtests, use superpowers:systematic-debugging: check for children still alive after `t.after` (every `client` registers `close`), for open handles (`--test-reporter=spec`, `process._getActiveHandles()`), and whether the abort comes from `tsx --test` versus `node --import tsx --test`. Record the cause and fix in the commit message; do not mask it with `--test-force-exit` unless the cause is shown to be in a dependency.

- [ ] **Step 8: Run under the bundled Bun**

Run: `cd apps/desktop && DESKTOP_RUNTIME="$PWD/src-tauri/resources/darwin-arm64/bun" npx tsx --test checks/backend.spec.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck -w apps/desktop`
Expected: errors only in `src/` and `checks/controller.spec.ts`.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/backend/server.ts apps/desktop/backend/main.ts apps/desktop/checks/support/fake-backend.ts apps/desktop/checks/backend.spec.ts apps/desktop/scripts/bundle.mjs apps/desktop/package.json
git commit -m "feat: serve the machine session over protocol v2 on stdio"
```

---

### Task 6: Rust host on protocol v2

**Files:**
- Modify: `apps/desktop/src-tauri/src/host.rs`, `apps/desktop/src-tauri/src/main.rs`, `apps/desktop/src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: the protocol from Task 2; the bundled resources from Task 5.
- Produces (Rust): `pub enum Request { Inspect, Preview { exclude: Vec<String> }, Apply { plan_id: String }, Cancel, Shutdown }`; `Backend::spawn(resources: &Path, home: Option<&Path>, emit: Emit) -> Result<Backend, String>`; `Backend::request(&self, request: Request) -> Result<Value, String>` (errors are `"CODE: message"`).
- Produces (Tauri commands, used by Task 7's bridge): `backend_generation`, `inspect_machine`, `preview_plan { exclude: string[] }`, `apply_plan { planId: string }`, `cancel_apply`, `restart_backend`. Each returns `{ generation: number, data: unknown }`; `backend_generation` and `restart_backend` return `data: null`. Events are emitted on `machine-backend` as the backend's run event plus `generation`, or `{ event: 'disconnected', detail, generation }`.
- Resource directory in the bundle: `backend-runtime` (was `fixture-runtime`).

- [ ] **Step 1: Write the failing Rust tests** — replace the two test modules in `host.rs` with:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn checkout() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap()
    }
    fn runtime() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/darwin-arm64")
    }
    // A temporary HOME; with `record`, its state.json names this checkout.
    fn home(record: bool) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let dir = std::env::temp_dir().join(format!("nortuscc-host-home-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let state = dir.join(".config/nortuscc");
        std::fs::create_dir_all(&state).unwrap();
        if record {
            std::fs::write(state.join("state.json"), json!({"version":1,"repo":checkout(),"skillsOnly":false,"files":{}}).to_string()).unwrap();
        }
        dir
    }
    #[test]
    fn rejects_invalid_events_and_responses() {
        for value in [
            json!({"version":1,"id":"x","ok":true,"result":null}),
            json!({"version":2,"id":"😀".repeat(60),"ok":true,"result":null}),
            json!({"version":2,"event":"progress","runId":"r","progress":{"type":"exploded"}}),
            json!({"version":2,"event":"progress","runId":"r","progress":"done"}),
            json!({"version":1,"event":"progress","operationId":"x","state":"running","percent":1,"detail":""}),
            json!({"version":2,"id":"x","ok":true,"result":null,"extra":true}),
        ] {
            assert!(validate(&value).is_err(), "{value}");
        }
        assert!(validate(&json!({"version":2,"id":"x","ok":true,"result":null})).is_ok());
        assert!(validate(&json!({"version":2,"event":"progress","runId":"r","progress":{"type":"done","ok":1,"failed":0}})).is_ok());
    }
    #[test]
    fn records_are_bounded_at_one_mebibyte() {
        assert!(bounded_line(&mut BufReader::new(std::io::Cursor::new(vec![b'x'; MAX_RECORD + 1]))).is_err());
        let mut big = vec![b'x'; MAX_RECORD];
        big.push(b'\n');
        assert_eq!(bounded_line(&mut BufReader::new(std::io::Cursor::new(big))).unwrap().unwrap().len(), MAX_RECORD);
        assert!(bounded_line(&mut BufReader::new(std::io::Cursor::new(b"{}"))).is_err());
    }
    #[test]
    fn requests_carry_only_allow_listed_arguments() {
        let line = Request::Preview { exclude: vec!["config:a".into()] }.record("7").unwrap();
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), json!({"version":2,"id":"7","command":"preview","exclude":["config:a"]}));
        let line = Request::Apply { plan_id: "p".into() }.record("8").unwrap();
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), json!({"version":2,"id":"8","command":"apply","planId":"p"}));
        assert!(Request::Preview { exclude: vec!["k".into(); MAX_EXCLUDED + 1] }.record("1").is_err());
        assert!(Request::Preview { exclude: vec!["x".repeat(MAX_KEY + 1)] }.record("1").is_err());
        assert!(Request::Preview { exclude: vec![String::new()] }.record("1").is_err());
        assert!(Request::Apply { plan_id: String::new() }.record("1").is_err());
        assert!(Request::Apply { plan_id: "x".repeat(101) }.record("1").is_err());
    }
    #[test]
    fn real_backend_inspects_previews_applies_and_restarts() {
        let home = home(true);
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let owner = Backend::spawn(&runtime(), Some(&home), Arc::new(move |e| captured.lock().unwrap().push(e))).unwrap();
        let inspected = owner.request(Request::Inspect).unwrap();
        assert_eq!(inspected["profile"]["repo"], json!(checkout()));
        let preview = owner.request(Request::Preview { exclude: vec![] }).unwrap();
        let plan_id = preview["planId"].as_str().unwrap().to_string();
        let applied = owner.request(Request::Apply { plan_id }).unwrap();
        assert_eq!(applied["status"], "started");
        let deadline = Instant::now() + Duration::from_secs(30);
        while !events.lock().unwrap().iter().any(|e| e["progress"]["type"] == "done") {
            assert!(Instant::now() < deadline, "no done event: {:?}", events.lock().unwrap());
            thread::sleep(Duration::from_millis(20));
        }
        assert!(owner.request(Request::Preview { exclude: vec!["not-an-item".into()] }).unwrap_err().starts_with("UNKNOWN_KEY"));
        assert!(!home.join(".config/nortuscc/apply.lock").exists());
        owner.inner.child.lock().unwrap().kill().unwrap();
        thread::sleep(Duration::from_millis(80));
        assert!(owner.request(Request::Inspect).is_err());
        drop(owner);
        let fresh = Backend::spawn(&runtime(), Some(&home), Arc::new(|_| {})).unwrap();
        assert!(fresh.request(Request::Inspect).is_ok());
        drop(fresh);
        std::fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn real_backend_reports_a_missing_checkout_record() {
        let home = home(false);
        let owner = Backend::spawn(&runtime(), Some(&home), Arc::new(|_| {})).unwrap();
        assert!(owner.request(Request::Inspect).unwrap_err().starts_with("REPO_NOT_FOUND"));
        drop(owner);
        std::fs::remove_dir_all(home).unwrap();
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    fn fake_backend(source: &str, emit: Emit) -> (Backend, PathBuf) {
        static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);
        let directory = std::env::temp_dir().join(format!(
            "nortuscc-host-test-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir(&directory).unwrap();
        let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/darwin-arm64/bun");
        std::os::unix::fs::symlink(runtime, directory.join("bun")).unwrap();
        std::fs::write(directory.join("backend.mjs"), source).unwrap();
        (Backend::spawn(&directory, None, emit).unwrap(), directory)
    }
    const IDLE: &str = "process.stdin.resume(); setInterval(() => {}, 1000)";
    #[test]
    fn timeout_disconnects_owner_and_no_request_is_retried() {
        let (backend, directory) = fake_backend(IDLE, Arc::new(|_| {}));
        assert!(backend.request_timeout(Request::Inspect, Duration::from_millis(60)).unwrap_err().contains("timed out"));
        assert!(backend.request(Request::Cancel).unwrap_err().contains("disconnected"));
        drop(backend);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn malformed_oversized_output_rejects_pending_requests() {
        for output in ["{broken".to_string(), "x".repeat(MAX_RECORD + 1)] {
            let source = format!("process.stdin.once('data', () => process.stdout.write({} + '\\n')); {IDLE}", serde_json::to_string(&output).unwrap());
            let (backend, directory) = fake_backend(&source, Arc::new(|_| {}));
            let started = Instant::now();
            assert!(backend.request(Request::Inspect).is_err());
            assert!(started.elapsed() < Duration::from_secs(5));
            drop(backend);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
    #[test]
    fn child_death_rejects_every_pending_request() {
        let (backend, directory) = fake_backend(IDLE, Arc::new(|_| {}));
        let backend = Arc::new(backend);
        let mut requests = Vec::new();
        for _ in 0..3 {
            let backend = backend.clone();
            requests.push(thread::spawn(move || backend.request(Request::Inspect)));
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while backend.inner.pending.lock().unwrap().len() < 3 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(backend.inner.pending.lock().unwrap().len(), 3);
        backend.inner.child.lock().unwrap().kill().unwrap();
        for request in requests {
            assert!(request.join().unwrap().unwrap_err().contains("exited"));
        }
        drop(backend);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn run_events_are_forwarded_and_a_v1_event_disconnects() {
        let source = r#"
            import { createInterface } from 'node:readline';
            createInterface({ input: process.stdin }).on('line', (line) => {
                const { id } = JSON.parse(line);
                process.stdout.write(JSON.stringify({ version: 2, id, ok: true, result: { status: 'started', runId: 'r' } }) + '\n');
                process.stdout.write(JSON.stringify({ version: 2, event: 'progress', runId: 'r', progress: { type: 'done', ok: 0, failed: 0 } }) + '\n');
                process.stdout.write(JSON.stringify({ version: 1, event: 'progress', operationId: 'x', state: 'running', percent: 1, detail: '' }) + '\n');
            });
        "#;
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let (backend, directory) = fake_backend(source, Arc::new(move |e| captured.lock().unwrap().push(e)));
        assert_eq!(backend.request(Request::Apply { plan_id: "p".into() }).unwrap()["status"], "started");
        let deadline = Instant::now() + Duration::from_secs(2);
        while events.lock().unwrap().len() < 2 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let events = events.lock().unwrap().clone();
        assert_eq!(events[0]["progress"]["type"], "done");
        assert_eq!(events[1]["event"], "disconnected");
        drop(backend);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
```

- [ ] **Step 2: Run to see it fail**

Run: `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: compile errors (`Request`, `MAX_EXCLUDED`, `MAX_KEY`, new `spawn` signature).

- [ ] **Step 3: Implement the host changes in `host.rs`**

1. Constants and the request type (replace `MAX_RECORD`, `REQUEST_TIMEOUT`):

```rust
const MAX_RECORD: usize = 1_048_576;
const MAX_EXCLUDED: usize = 10_000;
const MAX_KEY: usize = 500;

/// The only requests the renderer can cause. Arguments are opaque item keys and plan ids,
/// never paths or commands.
pub enum Request {
    Inspect,
    Preview { exclude: Vec<String> },
    Apply { plan_id: String },
    Cancel,
    Shutdown,
}
impl Request {
    fn command(&self) -> &'static str {
        match self {
            Request::Inspect => "inspect",
            Request::Preview { .. } => "preview",
            Request::Apply { .. } => "apply",
            Request::Cancel => "cancel",
            Request::Shutdown => "shutdown",
        }
    }
    // Inspect and apply re-read the machine, which can take seconds; cancel waits for a step.
    fn timeout(&self) -> Duration {
        Duration::from_secs(match self {
            Request::Inspect | Request::Apply { .. } => 60,
            Request::Preview { .. } => 10,
            Request::Cancel => 30,
            Request::Shutdown => 5,
        })
    }
    fn record(&self, id: &str) -> Result<String, String> {
        let mut record = json!({"version": 2, "id": id, "command": self.command()});
        match self {
            Request::Preview { exclude } => {
                if exclude.len() > MAX_EXCLUDED
                    || exclude.iter().any(|key| key.is_empty() || key.encode_utf16().count() > MAX_KEY)
                {
                    return Err("Invalid item keys".into());
                }
                record["exclude"] = json!(exclude);
            }
            Request::Apply { plan_id } => {
                if !valid_id(plan_id) {
                    return Err("Invalid plan id".into());
                }
                record["planId"] = json!(plan_id);
            }
            _ => {}
        }
        let line = format!("{record}\n");
        if line.len() > MAX_RECORD {
            return Err("Request exceeds the record limit".into());
        }
        Ok(line)
    }
}
```

2. Replace the `Progress` struct and its branch in `validate` with a run-event envelope; bump responses to version 2:

```rust
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunEvent {
    version: u8,
    event: String,
    #[serde(rename = "runId")]
    run_id: String,
    progress: serde_json::Map<String, Value>,
}
// in validate():
    if message.get("event").is_some() {
        let m: RunEvent = serde_json::from_value(message.clone()).map_err(|_| "Invalid run event")?;
        let kind = m.progress.get("type").and_then(Value::as_str).unwrap_or("");
        if m.version != 2
            || m.event != "progress"
            || !valid_id(&m.run_id)
            || !["started", "finished", "done", "cancelled", "failed"].contains(&kind)
        {
            return Err("Invalid run event contract".into());
        }
    }
```

and change both `m.version != 1` checks for `Success` and `Failure` to `!= 2`. The renderer decodes each progress payload strictly (Task 7); Rust checks the envelope and the type tag.

3. Remove `SessionDirectory`, the `session` field of `Inner`, the `remove_dir_all` in `force_stop`, the `NORTUSCC_FIXTURE_SESSION` env, and the `eprintln!("host: … session …")` line.

4. `spawn` gains `home`:

```rust
    /// Starts the bundled backend. `home`, when given, makes the child a self-contained machine at
    /// that HOME (tests and smoke): it sets HOME and drops any inherited NORTUSCC_* overrides.
    pub fn spawn(resources: &Path, home: Option<&Path>, emit: Emit) -> Result<Self, String> {
        // … existing runtime checks …
        let mut command = Command::new(bun);
        command
            .arg(script)
            .current_dir(resources)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .env_remove("BUN_OPTIONS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(home) = home {
            command.env("HOME", home);
            for (key, _) in std::env::vars_os() {
                if key.to_string_lossy().starts_with("NORTUSCC_") {
                    command.env_remove(key);
                }
            }
        }
        // … rest unchanged …
```

5. `request`/`request_timeout` take a `Request`:

```rust
    pub fn request(&self, request: Request) -> Result<Value, String> {
        let timeout = request.timeout();
        self.request_timeout(request, timeout)
    }
    fn request_timeout(&self, request: Request, timeout: Duration) -> Result<Value, String> {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst).to_string();
        let record = request.record(&id)?;
        // … register pending, write `record`, wait `timeout` — as before …
    }
```

and `shutdown()` calls `self.request_timeout(Request::Shutdown, Duration::from_secs(5))`, then waits up to 1.5 s for exit before force-stopping, as before.

- [ ] **Step 4: Update `main.rs`**

- `use host::{Backend, Request};`. Event name `"machine-backend"`. `Owner::spawn` calls `Backend::spawn(&self.resources, None, emit)`. `Owner::request(&self, request: Request)`.
- `dispatch(owner, request: Request)` (no longer `&'static str`).
- Commands:

```rust
#[tauri::command]
async fn backend_generation(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    let session = owner.session.lock().unwrap();
    if session.backend.is_none() {
        return Err("Backend unavailable; restart explicitly".into());
    }
    Ok(json!({"generation": session.generation, "data": null}))
}
#[tauri::command]
async fn inspect_machine(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    dispatch(owner, Request::Inspect).await
}
#[tauri::command]
async fn preview_plan(owner: tauri::State<'_, Arc<Owner>>, exclude: Vec<String>) -> Result<Value, String> {
    dispatch(owner, Request::Preview { exclude }).await
}
#[tauri::command]
async fn apply_plan(owner: tauri::State<'_, Arc<Owner>>, plan_id: String) -> Result<Value, String> {
    dispatch(owner, Request::Apply { plan_id }).await
}
#[tauri::command]
async fn cancel_apply(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    dispatch(owner, Request::Cancel).await
}
```

- `restart_backend`: shut down the old backend, bump the generation, spawn, and return `{"generation": …, "data": null}` without inspecting (the renderer inspects next, so a failed inspect no longer looks like a failed restart).
- Remove `inspect_fixture`, `start_fixture`, `cancel_fixture`, `crash_probe`; register `backend_generation, inspect_machine, preview_plan, apply_plan, cancel_apply, restart_backend`.
- Resource dir: `.join("backend-runtime")` in both setup and the `--smoke` default (`../Resources/backend-runtime`).
- `smoke(resources)`:

```rust
// Exercises the packaged owner against the machine at $HOME (the smoke script passes a temporary one).
fn smoke(resources: PathBuf) -> Result<(), String> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let backend = Backend::spawn(&resources, None, Arc::new(move |event| captured.lock().unwrap().push(event)))?;
    let inspected = backend.request(Request::Inspect)?;
    if !inspected["items"].is_array() || !inspected["profile"]["repo"].is_string() {
        return Err(format!("Unexpected inspect result {inspected}"));
    }
    let preview = backend.request(Request::Preview { exclude: vec![] })?;
    let plan_id = preview["planId"].as_str().ok_or("Missing plan id")?.to_string();
    let applied = backend.request(Request::Apply { plan_id })?;
    if applied["status"] != "started" {
        return Err(format!("Unexpected apply result {applied}"));
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        let end = events.lock().unwrap().iter().find_map(|e| {
            let kind = e["progress"]["type"].as_str()?;
            ["done", "cancelled", "failed"].contains(&kind).then(|| e.clone())
        });
        if let Some(end) = end {
            if end["progress"]["type"] != "done" {
                return Err(format!("Apply did not complete: {end}"));
            }
            break;
        }
        if std::time::Instant::now() > deadline {
            return Err("Apply did not finish".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if !backend.request(Request::Preview { exclude: vec!["not-an-item".into()] }).unwrap_err().starts_with("UNKNOWN_KEY") {
        return Err("Expected an unknown key to be refused".into());
    }
    backend.request(Request::Cancel)?;
    backend.shutdown();
    println!("Packaged Rust owner smoke passed");
    Ok(())
}
```

- [ ] **Step 5: Update `tauri.conf.json`**

`productName` and window `title` → `"Nortuscc"`; `identifier` → `"com.nortuscc.desktop"`; `bundle.resources` → `{ "resources/darwin-arm64/": "backend-runtime/" }`. Leave the CSP as is.

- [ ] **Step 6: Run the Rust tests**

Run: `npm run resources -w apps/desktop && PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: all PASS. `cargo build` warnings for unused fields are errors in spirit: fix them (e.g. drop `let _ = m.result;` patterns only if they become unused).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/host.rs apps/desktop/src-tauri/src/main.rs apps/desktop/src-tauri/tauri.conf.json
git commit -m "feat: move the Rust host to protocol v2 with per-command timeouts"
```

---

### Task 7: Renderer — profile, inspect, preview, apply with progress and cancel

**Files:**
- Rewrite: `apps/desktop/src/bridge.ts`, `apps/desktop/src/controller.ts`, `apps/desktop/src/main.tsx`, `apps/desktop/checks/controller.spec.ts`
- Modify: `apps/desktop/src/style.css`

**Interfaces:**
- Consumes: Task 2 decoders and types; Task 6 Tauri commands and the `machine-backend` event.
- Produces:
  - `bridge.ts`: `type Command = 'backend_generation' | 'inspect_machine' | 'preview_plan' | 'apply_plan' | 'cancel_apply' | 'restart_backend'`; `type HostEvent = (RunEvent | { event: 'disconnected'; detail: string }) & { generation: number }`; `type Envelope = { generation: number; data: unknown }`; `interface Bridge { subscribe(receive): Promise<() => void>; invoke(command: Command, args?: Readonly<Record<string, unknown>>): Promise<Envelope> }`; `decodeHostEvent`, `nativeAvailable`, `nativeBridge`.
  - `controller.ts`: `type StepStatus`, `type StepView`, `type RunView`, `type ViewState` (below), `advance(run: RunView, progress: RunProgress): RunView`, `class MachineController { connect, inspect, toggle(key), previewPlan, apply, cancel, restart, dispose, subscribe, snapshot, state }`.

```ts
export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'cancelled';
export type StepView = { readonly key: string; readonly summary: string; readonly status: StepStatus; readonly note: string };
export type RunView = {
  readonly runId: string;
  readonly steps: ReadonlyArray<StepView>;
  readonly outcome: 'running' | 'done' | 'cancelled' | 'failed';
  readonly summary: string;
  readonly backups?: string;
};
export type ViewState = {
  readonly connection: 'connecting' | 'connected' | 'disconnected' | 'browser';
  readonly inspection: InspectResult | null;
  readonly excluded: ReadonlyArray<string>;
  readonly preview: PreviewResult | null;
  readonly run: RunView | null;
  readonly pending: boolean;
  readonly detail: string;
};
```

Controller rules:
- `connect`: subscribe first, then `backend_generation` (establishes the generation and applies a retained early disconnect for that generation, as the fixture controller did), then inspect. A failed inspect (e.g. `REPO_NOT_FOUND: …`) leaves the connection `connected`, `inspection: null`, and the message in `detail`.
- `ready` = connected, not pending, and no run with outcome `running`. `inspect`, `toggle`, `previewPlan`, `apply` act only when ready.
- `inspect` success replaces `inspection`, clears `preview`, and drops excluded keys that are no longer items.
- `toggle(key)` flips the key in `excluded` and clears `preview`.
- `previewPlan` invokes `preview_plan { exclude }` with the excluded keys only.
- `apply` invokes `apply_plan { planId }` for the current preview. `stale` replaces the preview with the new one and sets `detail` to `The machine changed since this preview. Review the updated plan, then apply again.`; `started` creates a `RunView` from the preview's steps (all `pending`), then replays events buffered for that run id while the request was in flight (buffer capped at 10,000 events).
- Events: ignored unless the generation matches and connection is `connected`; buffered while `apply` is in flight; else applied only to the current run with outcome `running`. A terminal event (`done`, `cancelled`, `failed`) clears the preview and re-inspects.
- `disconnected` for the current generation: connection `disconnected`, pending cleared, and a running run becomes `failed` with summary `Backend disconnected during the run`.
- `cancel` invokes `cancel_apply` only while a run is `running`; it does not set `pending`.
- `restart`: as the fixture controller (revision bump, generation reset, `connecting`), invokes `restart_backend`, establishes, clears `run` and `preview`, then inspects.
- A revision counter makes superseded replies inert, as in the fixture controller.

- [ ] **Step 1: Write the failing controller tests** — replace `apps/desktop/checks/controller.spec.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { MachineController, advance, type RunView } from '../src/controller.ts';
import type { Bridge, Command, HostEvent } from '../src/bridge.ts';

const step = (key: string) => ({ key, domain: 'config', action: 'write-file', summary: `write ${key}`, touches: [key], interruptible: false });
const inspection = (keys: string[]) => ({
  profile: { repo: '/r', revision: 'abc', overrides: '/s/overrides.json', issues: [] },
  items: keys.map((key) => ({ key, domain: 'config', target: 'claude', label: key, group: 'Files', state: 'repo-ahead', disposition: 'apply' })),
  probeErrors: [],
});
const plan = (keys: string[]) => ({ kind: 'apply', steps: keys.map(step), skipped: [] });
const event = (runId: string, progress: unknown, generation = 1): HostEvent => ({ generation, version: 2, event: 'progress', runId, progress } as HostEvent);

type Handler = (args?: Readonly<Record<string, unknown>>) => unknown;
function fake(handlers: Partial<Record<Command, Handler>>, generation = 1) {
  const calls: Array<[Command, unknown]> = [];
  let receive: (event: HostEvent) => void = () => {};
  const bridge: Bridge = {
    subscribe: async (r) => {
      calls.push(['subscribe' as Command, undefined]);
      receive = r;
      return () => {};
    },
    invoke: async (command, args) => {
      calls.push([command, args]);
      const handler = handlers[command];
      const data = handler ? await handler(args) : null;
      return { generation, data };
    },
  };
  return { bridge, calls, emit: (e: HostEvent) => receive(e) };
}

test('connect subscribes, learns the generation, then inspects', async () => {
  const f = fake({ inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.deepEqual(f.calls.map(([name]) => name), ['subscribe', 'backend_generation', 'inspect_machine']);
  assert.equal(c.state.connection, 'connected');
  assert.equal(c.state.inspection?.items.length, 1);
});

test('a failed inspect keeps the app connected and shows why', async () => {
  const f = fake({ inspect_machine: () => { throw new Error("REPO_NOT_FOUND: the recorded checkout /old is not a nortuscc checkout. Run 'nortuscc setup --dir <checkout>'"); } });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.equal(c.state.connection, 'connected');
  assert.equal(c.state.inspection, null);
  assert.match(c.state.detail, /\/old/);
});

test('toggling excludes a key from the preview and clears a stale preview', async () => {
  const f = fake({ inspect_machine: () => inspection(['config:a', 'config:b']), preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }) });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  assert.equal(c.state.preview?.planId, 'p1');
  c.toggle('config:b');
  assert.equal(c.state.preview, null);
  await c.previewPlan();
  assert.deepEqual(f.calls.filter(([n]) => n === 'preview_plan').map(([, a]) => a), [{ exclude: [] }, { exclude: ['config:b'] }]);
});

test('apply replays early events, tracks steps, and re-inspects when done', async () => {
  let inspects = 0;
  const f = fake({
    inspect_machine: () => (++inspects, inspection(['config:a', 'config:b'])),
    preview_plan: () => ({ planId: 'p1', plan: plan(['config:a', 'config:b']) }),
    apply_plan: () => {
      f.emit(event('r1', { type: 'started', index: 0, total: 2, step: step('config:a') }));
      return { status: 'started', runId: 'r1' };
    },
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  assert.deepEqual(f.calls.find(([n]) => n === 'apply_plan')?.[1], { planId: 'p1' });
  assert.deepEqual(c.state.run?.steps.map((s) => s.status), ['running', 'pending']);
  f.emit(event('other', { type: 'done', ok: 9, failed: 0 }));
  f.emit(event('r1', { type: 'done', ok: 9, failed: 0 }, 0));
  assert.equal(c.state.run?.outcome, 'running');
  f.emit(event('r1', { type: 'finished', index: 0, total: 2, key: 'config:a', outcome: 'ok', note: '' }));
  f.emit(event('r1', { type: 'started', index: 1, total: 2, step: step('config:b') }));
  f.emit(event('r1', { type: 'finished', index: 1, total: 2, key: 'config:b', outcome: 'failed', note: 'disk full' }));
  f.emit(event('r1', { type: 'done', ok: 1, failed: 1, backups: '/b/nortuscc-1' }));
  assert.equal(c.state.run?.outcome, 'done');
  assert.equal(c.state.run?.backups, '/b/nortuscc-1');
  assert.deepEqual(c.state.run?.steps.map((s) => [s.status, s.note]), [['ok', ''], ['failed', 'disk full']]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(inspects, 2);
  assert.equal(c.state.preview, null);
});

test('a stale apply replaces the preview and starts nothing', async () => {
  const f = fake({
    inspect_machine: () => inspection(['config:a']),
    preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }),
    apply_plan: () => ({ status: 'stale', planId: 'p2', plan: plan(['config:a', 'config:new']) }),
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  assert.equal(c.state.run, null);
  assert.equal(c.state.preview?.planId, 'p2');
  assert.match(c.state.detail, /changed since this preview/);
});

test('cancel reaches the backend and a cancelled run keeps unstarted steps pending', async () => {
  const f = fake({
    inspect_machine: () => inspection(['config:a', 'config:b']),
    preview_plan: () => ({ planId: 'p1', plan: plan(['config:a', 'config:b']) }),
    apply_plan: () => ({ status: 'started', runId: 'r1' }),
    cancel_apply: () => ({ cancelled: true }),
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  f.emit(event('r1', { type: 'started', index: 0, total: 2, step: step('config:a') }));
  await c.cancel();
  assert.ok(f.calls.some(([n]) => n === 'cancel_apply'));
  f.emit(event('r1', { type: 'finished', index: 0, total: 2, key: 'config:a', outcome: 'cancelled', note: 'cancelled' }));
  f.emit(event('r1', { type: 'cancelled', remaining: ['config:b'] }));
  assert.equal(c.state.run?.outcome, 'cancelled');
  assert.deepEqual(c.state.run?.steps.map((s) => s.status), ['cancelled', 'pending']);
});

test('a disconnect fails the running run; restart clears it and ignores the old generation', async () => {
  let generation = 1;
  const f = fake({
    inspect_machine: () => inspection(['config:a']),
    preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }),
    apply_plan: () => ({ status: 'started', runId: 'r1' }),
    restart_backend: () => ((generation = 2), null),
  });
  const bridge: Bridge = { ...f.bridge, invoke: async (command, args) => ({ ...(await f.bridge.invoke(command, args)), generation }) };
  const c = new MachineController(bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  f.emit({ generation: 1, event: 'disconnected', detail: 'Backend exited; restart explicitly' });
  assert.equal(c.state.connection, 'disconnected');
  assert.equal(c.state.run?.outcome, 'failed');
  await c.restart();
  assert.equal(c.state.connection, 'connected');
  assert.equal(c.state.run, null);
  f.emit({ generation: 1, event: 'disconnected', detail: 'late' });
  assert.equal(c.state.connection, 'connected');
});

test('advance ignores nothing it should not', () => {
  const run: RunView = { runId: 'r', steps: [{ key: 'a', summary: 'a', status: 'pending', note: '' }], outcome: 'running', summary: '' };
  assert.equal(advance(run, { type: 'failed', message: 'another nortuscc run (pid 4) holds /s/apply.lock' }).summary, 'another nortuscc run (pid 4) holds /s/apply.lock');
  assert.equal(advance(run, { type: 'failed', message: 'x' }).outcome, 'failed');
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd apps/desktop && npx tsx --test checks/controller.spec.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Rewrite `apps/desktop/src/bridge.ts`**

```ts
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Schema } from 'effect';
import { decodeMessage, type RunEvent } from '../backend/protocol.ts';

// The renderer's whole reach: these commands, with opaque keys and plan ids as their only arguments.
export type Command = 'backend_generation' | 'inspect_machine' | 'preview_plan' | 'apply_plan' | 'cancel_apply' | 'restart_backend';
export type HostEvent = (RunEvent | { event: 'disconnected'; detail: string }) & { generation: number };
export type Envelope = { generation: number; data: unknown };
export interface Bridge {
  subscribe(receive: (event: HostEvent) => void): Promise<() => void>;
  invoke(command: Command, args?: Readonly<Record<string, unknown>>): Promise<Envelope>;
}

const Generation = Schema.Int.check(Schema.isGreaterThan(0));
const HostEnvelope = Schema.Struct({ generation: Generation, data: Schema.Unknown });
const Disconnected = Schema.Struct({ event: Schema.Literal('disconnected'), detail: Schema.String });

export function decodeHostEvent(value: unknown): HostEvent {
  if (typeof value !== 'object' || value === null || !('generation' in value)) throw new Error('Missing host generation');
  const { generation, ...message } = value;
  const checked = Schema.decodeUnknownSync(Generation)(generation);
  if ('event' in message && message.event === 'disconnected')
    return { ...Schema.decodeUnknownSync(Disconnected, { onExcessProperty: 'error' })(message), generation: checked };
  const decoded = decodeMessage(message);
  if (!('event' in decoded)) throw new Error('Expected a run event');
  return { ...decoded, generation: checked };
}

export const nativeAvailable = () => '__TAURI_INTERNALS__' in window;
export const nativeBridge: Bridge = {
  subscribe: (receive) =>
    listen<unknown>('machine-backend', (event) => {
      try {
        receive(decodeHostEvent(event.payload));
      } catch (error) {
        console.error('Invalid host event', error);
      }
    }),
  invoke: async (command, args) =>
    Schema.decodeUnknownSync(HostEnvelope, { onExcessProperty: 'error' })(await invoke(command, args)),
};
```

- [ ] **Step 4: Rewrite `apps/desktop/src/controller.ts`**

```ts
import {
  decodeApplyResult, decodeInspectResult, decodePreviewResult,
  type InspectResult, type PreviewResult, type RunEvent, type RunProgress,
} from '../backend/protocol.ts';
import type { Bridge, Envelope, HostEvent } from './bridge.ts';

// (StepStatus, StepView, RunView, ViewState exactly as in this task's Interfaces block.)

const MAX_EARLY_EVENTS = 10_000;
const STALE = 'The machine changed since this preview. Review the updated plan, then apply again.';
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const backups = (path: string | undefined) => (path ? { backups: path } : {});

// Folds one progress event into a run's view.
export function advance(run: RunView, progress: RunProgress): RunView {
  const mark = (index: number, status: StepStatus, note = '') =>
    run.steps.map((s, i) => (i === index ? { ...s, status, note } : s));
  switch (progress.type) {
    case 'started':
      return { ...run, steps: mark(progress.index, 'running'), summary: progress.step.summary };
    case 'finished':
      return { ...run, steps: mark(progress.index, progress.outcome, progress.note) };
    case 'done':
      return { ...run, outcome: 'done', summary: `${progress.ok} applied, ${progress.failed} failed`, ...backups(progress.backups) };
    case 'cancelled':
      return { ...run, outcome: 'cancelled', summary: `Cancelled; ${progress.remaining.length} not started`, ...backups(progress.backups) };
    case 'failed':
      return { ...run, outcome: 'failed', summary: progress.message };
  }
}

// Drives the narrow bridge: ignores events from old backends, old runs and superseded replies.
export class MachineController {
  state: ViewState = {
    connection: 'connecting', inspection: null, excluded: [], preview: null, run: null, pending: false,
    detail: 'Connecting to the bundled backend',
  };
  private generation: number | null = null;
  private disposed = false;
  private unlisten?: () => void;
  private listeners = new Set<() => void>();
  private revision = 0;
  private starting = false;
  private early: RunEvent[] = [];
  private earlyDisconnects = new Map<number, Extract<HostEvent, { event: 'disconnected' }>>();

  constructor(private bridge: Bridge | null) {
    if (!bridge) this.state = { ...this.state, connection: 'browser', detail: 'Browser preview. Open the desktop app to inspect this machine.' };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = () => this.state;

  private update(update: Partial<ViewState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  private owns(revision: number) {
    return !this.disposed && this.revision === revision;
  }
  private current(revision: number, reply: Envelope) {
    return this.owns(revision) && reply.generation === this.generation && this.state.connection === 'connected';
  }
  private ready() {
    return this.bridge !== null && this.state.connection === 'connected' && !this.state.pending && this.state.run?.outcome !== 'running';
  }

  // Adopts a backend generation; a disconnect for it that arrived first wins.
  private establish(reply: Envelope, detail: string, revision: number) {
    if (!this.owns(revision)) return false;
    this.generation = reply.generation;
    const disconnected = this.earlyDisconnects.get(reply.generation);
    this.earlyDisconnects.clear();
    if (disconnected) {
      this.revision++;
      this.update({ connection: 'disconnected', pending: false, detail: disconnected.detail });
      return false;
    }
    this.update({ connection: 'connected', detail });
    return true;
  }

  async connect() {
    if (!this.bridge) return;
    const revision = ++this.revision;
    this.generation = null;
    this.earlyDisconnects.clear();
    this.update({ pending: true });
    try {
      const unlisten = await this.bridge.subscribe((event) => this.receive(event));
      if (!this.owns(revision)) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
      if (!this.establish(await this.bridge.invoke('backend_generation'), 'Bundled backend connected', revision)) return;
      await this.load(revision);
    } catch (error) {
      if (this.owns(revision)) this.update({ connection: 'disconnected', detail: message(error) });
    } finally {
      if (this.owns(revision)) this.update({ pending: false });
    }
  }

  // Inspects within an action that already holds `pending`; a refusal leaves the app connected.
  private async load(revision: number) {
    this.update({ detail: 'Inspecting this machine' });
    try {
      const reply = await this.bridge!.invoke('inspect_machine');
      if (!this.current(revision, reply)) return;
      const inspection = decodeInspectResult(reply.data);
      const keys = new Set(inspection.items.map((item) => item.key));
      this.update({
        inspection, preview: null, excluded: this.state.excluded.filter((key) => keys.has(key)),
        detail: `Inspected ${inspection.items.length} items`,
      });
    } catch (error) {
      if (this.owns(revision)) this.update({ inspection: null, preview: null, detail: message(error) });
    }
  }

  async inspect() {
    if (!this.ready()) return;
    const revision = ++this.revision;
    this.update({ pending: true });
    try {
      await this.load(revision);
    } finally {
      if (this.owns(revision)) this.update({ pending: false });
    }
  }

  toggle(key: string) {
    if (!this.ready()) return;
    const excluded = this.state.excluded.includes(key) ? this.state.excluded.filter((k) => k !== key) : [...this.state.excluded, key];
    this.update({ excluded, preview: null });
  }

  async previewPlan() {
    if (!this.ready() || !this.state.inspection) return;
    const revision = ++this.revision;
    this.update({ pending: true, detail: 'Planning' });
    try {
      const reply = await this.bridge!.invoke('preview_plan', { exclude: [...this.state.excluded] });
      if (!this.current(revision, reply)) return;
      const preview = decodePreviewResult(reply.data);
      this.update({ preview, detail: `${preview.plan.steps.length} steps, ${preview.plan.skipped.length} skipped` });
    } catch (error) {
      if (this.owns(revision)) this.update({ detail: message(error) });
    } finally {
      if (this.owns(revision)) this.update({ pending: false });
    }
  }

  async apply() {
    const preview = this.state.preview;
    if (!this.ready() || !preview) return;
    const revision = ++this.revision;
    this.starting = true;
    this.early = [];
    this.update({ pending: true, detail: 'Re-inspecting before applying' });
    try {
      const reply = await this.bridge!.invoke('apply_plan', { planId: preview.planId });
      if (!this.current(revision, reply)) return;
      const result = decodeApplyResult(reply.data);
      if (result.status === 'stale') {
        this.update({ preview: { planId: result.planId, plan: result.plan }, detail: STALE });
        return;
      }
      const buffered = this.early.filter((event) => event.runId === result.runId);
      this.starting = false;
      this.early = [];
      const initial: RunView = {
        runId: result.runId, outcome: 'running', summary: 'Starting',
        steps: preview.plan.steps.map((step) => ({ key: step.key, summary: step.summary, status: 'pending', note: '' })),
      };
      const run = buffered.reduce((view, event) => (view.outcome === 'running' ? advance(view, event.progress) : view), initial);
      this.update({ run, detail: run.summary });
      if (run.outcome !== 'running') void this.settled(revision);
    } catch (error) {
      if (this.owns(revision)) this.update({ detail: message(error) });
    } finally {
      if (this.owns(revision)) {
        this.starting = false;
        this.early = [];
        this.update({ pending: false });
      }
    }
  }

  async cancel() {
    if (!this.bridge || this.state.connection !== 'connected' || this.state.run?.outcome !== 'running') return;
    try {
      await this.bridge.invoke('cancel_apply');
    } catch (error) {
      if (!this.disposed) this.update({ detail: message(error) });
    }
  }

  async restart() {
    if (!this.bridge || this.state.pending || this.state.run?.outcome === 'running') return;
    const revision = ++this.revision;
    this.generation = null;
    this.starting = false;
    this.early = [];
    this.earlyDisconnects.clear();
    this.update({ pending: true, connection: 'connecting', run: null, preview: null, detail: 'Starting a fresh backend' });
    try {
      if (!this.establish(await this.bridge.invoke('restart_backend'), 'Fresh backend connected', revision)) return;
      await this.load(revision);
    } catch (error) {
      if (this.owns(revision)) this.update({ connection: 'disconnected', detail: message(error) });
    } finally {
      if (this.owns(revision)) this.update({ pending: false });
    }
  }

  dispose() {
    this.disposed = true;
    this.revision++;
    this.earlyDisconnects.clear();
    this.unlisten?.();
    this.listeners.clear();
  }

  // After a run ends the preview is spent and the machine has changed: look again.
  private async settled(revision: number) {
    this.update({ preview: null });
    if (!this.owns(revision) && this.state.pending) return;
    await this.inspect();
  }

  private receive(event: HostEvent) {
    if (this.disposed) return;
    if (this.generation === null) {
      if (event.event === 'disconnected' && this.earlyDisconnects.size < 16) this.earlyDisconnects.set(event.generation, event);
      return;
    }
    if (event.generation !== this.generation) return;
    if (event.event === 'disconnected') {
      this.revision++;
      this.starting = false;
      this.early = [];
      const run = this.state.run?.outcome === 'running'
        ? { ...this.state.run, outcome: 'failed' as const, summary: 'Backend disconnected during the run' }
        : this.state.run;
      this.update({ connection: 'disconnected', pending: false, detail: event.detail, run });
      return;
    }
    if (this.state.connection !== 'connected') return;
    if (this.starting) {
      if (this.early.length < MAX_EARLY_EVENTS) this.early.push(event);
      return;
    }
    const run = this.state.run;
    if (!run || run.runId !== event.runId || run.outcome !== 'running') return;
    const next = advance(run, event.progress);
    this.update({ run: next, detail: next.summary });
    if (next.outcome !== 'running') void this.settled(this.revision);
  }
}
```

The `settled` guard simply avoids re-inspecting under someone else's pending action; if the test "re-inspects when done" fails because `pending` is still set from `apply`, defer with `queueMicrotask` or check `ready()` after the `apply` finally block — keep the behavior: exactly one re-inspect after a terminal event.

- [ ] **Step 5: Run the controller tests**

Run: `cd apps/desktop && npx tsx --test checks/controller.spec.ts`
Expected: PASS.

- [ ] **Step 6: Rewrite `apps/desktop/src/main.tsx`**

```tsx
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { WireObserved } from '../backend/protocol.ts';
import { MachineController, type StepStatus } from './controller.ts';
import { nativeAvailable, nativeBridge } from './bridge.ts';
import './style.css';

const DOMAINS = [['config', 'Configuration'], ['integrations', 'Integrations'], ['skills', 'Skills']] as const;
const MARK: Record<StepStatus, string> = { pending: '·', running: '…', ok: '✓', failed: '✕', cancelled: '–' };
const provenance = (item: WireObserved) => (item.from ? `${item.from.layer} · ${item.from.source}` : '—');

function App() {
  const [controller] = useState(() => new MachineController(nativeAvailable() ? nativeBridge : null));
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => {
    void controller.connect();
    return () => controller.dispose();
  }, [controller]);
  const running = state.run?.outcome === 'running';
  const ready = state.connection === 'connected' && !state.pending && !running;
  const inspection = state.inspection;
  const excluded = new Set(state.excluded);
  const groups = DOMAINS.map(([domain, title]) => ({ domain, title, items: inspection?.items.filter((i) => i.domain === domain) ?? [] }))
    .filter((group) => group.items.length > 0);
  const steps = state.preview?.plan.steps ?? [];
  const skipped = state.preview?.plan.skipped ?? [];
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">NORTUSCC / THIS MACHINE</p>
          <h1>Machine</h1>
          <p className="intro">Inspect this machine, preview the changes, then apply them with backups.</p>
        </div>
        <span className={`connection ${state.connection}`}>
          <i />
          {state.connection === 'browser' ? 'Browser preview' : state.connection}
        </span>
      </header>
      <div className="layout">
        <aside>
          <p className="eyebrow">PROFILE</p>
          {inspection ? (
            <dl className="profile">
              <dt>Repository</dt>
              <dd><code>{inspection.profile.repo}</code></dd>
              <dt>Revision</dt>
              <dd><code>{inspection.profile.revision?.slice(0, 12) ?? 'unknown'}</code></dd>
              <dt>Overrides</dt>
              <dd><code>{inspection.profile.overrides}</code></dd>
            </dl>
          ) : (
            <p className="muted">Not inspected</p>
          )}
          {inspection?.profile.issues.length ? (
            <div className="problems">
              <strong>Profile issues</strong>
              <ul>{inspection.profile.issues.map((issue, n) => <li key={n}>{issue.source}: {issue.path} — {issue.message}</li>)}</ul>
            </div>
          ) : null}
          {inspection?.probeErrors.length ? (
            <div className="problems">
              <strong>Probe failures</strong>
              <ul>{inspection.probeErrors.map((error, n) => <li key={n}>{error}</li>)}</ul>
            </div>
          ) : null}
          <button className="restart" disabled={state.connection === 'browser' || state.pending || running} onClick={() => void controller.restart()}>
            Restart backend
          </button>
        </aside>
        <div className="content">
          <section>
            <div className="section-head">
              <div>
                <p className="eyebrow">INSPECT</p>
                <h2>What this machine has</h2>
              </div>
              <button disabled={!ready} onClick={() => void controller.inspect()}>Inspect again</button>
            </div>
            {inspection === null ? (
              <p className="muted">{state.detail}</p>
            ) : groups.length === 0 ? (
              <p className="muted">No domain reported any items.</p>
            ) : (
              groups.map((group) => (
                <div className="table-wrap" key={group.domain}>
                  <table>
                    <caption>{group.title}</caption>
                    <thead>
                      <tr><th aria-label="Include" /><th>Item</th><th>State</th><th>Disposition</th><th>From</th></tr>
                    </thead>
                    <tbody>
                      {group.items.map((item) => (
                        <tr key={item.key}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Include ${item.label}`}
                              disabled={!ready || item.disposition !== 'apply'}
                              checked={item.disposition === 'apply' && !excluded.has(item.key)}
                              onChange={() => controller.toggle(item.key)}
                            />
                          </td>
                          <td>
                            <strong>{item.label}</strong>
                            <small>{item.group} · {item.target}</small>
                            {item.note ? <small>{item.note}</small> : null}
                          </td>
                          <td>{item.state}</td>
                          <td><span className={`disposition ${item.disposition}`}>{item.disposition}</span></td>
                          <td className="muted">{provenance(item)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </section>
          <section>
            <div className="section-head">
              <div>
                <p className="eyebrow">PREVIEW</p>
                <h2>{state.preview ? `${steps.length} steps` : 'Not previewed'}</h2>
              </div>
              <button disabled={!ready || !inspection} onClick={() => void controller.previewPlan()}>Preview changes</button>
            </div>
            {state.preview ? (
              <>
                {steps.length ? (
                  <ol className="steps">
                    {steps.map((step, n) => (
                      <li key={`${n}:${step.key}`}>
                        <span>{step.summary}</span>
                        <small>{step.domain} · {step.action}</small>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="muted">Nothing to apply.</p>
                )}
                {skipped.length ? (
                  <details>
                    <summary>{skipped.length} skipped</summary>
                    <ul className="skipped">{skipped.map((s, n) => <li key={`${n}:${s.key}`}><code>{s.key}</code> — {s.reason}</li>)}</ul>
                  </details>
                ) : null}
              </>
            ) : (
              <p className="muted">Preview to see exactly what Apply will change.</p>
            )}
          </section>
          <section className="operation">
            <div className="section-head">
              <div>
                <p className="eyebrow">APPLY</p>
                <h2 className="status">{state.connection === 'disconnected' ? 'Disconnected' : state.run?.outcome ?? 'Ready'}</h2>
              </div>
            </div>
            {state.run ? (
              <ol className="progress-steps">
                {state.run.steps.map((step, n) => (
                  <li key={`${n}:${step.key}`} className={step.status}>
                    <span aria-hidden="true">{MARK[step.status]}</span>
                    <span>{step.summary}</span>
                    {step.note ? <small>{step.note}</small> : null}
                  </li>
                ))}
              </ol>
            ) : null}
            {state.run?.backups ? <p>Backups: <code>{state.run.backups}</code></p> : null}
            <p className="detail" role="status" aria-live="polite">{state.detail}</p>
            <div className="actions">
              <button className="primary" disabled={!ready || steps.length === 0} onClick={() => void controller.apply()}>
                Apply {steps.length} steps
              </button>
              <button disabled={!running} onClick={() => void controller.cancel()}>Cancel</button>
            </div>
          </section>
        </div>
      </div>
      <footer>Every replaced file is backed up to this run's backup folder first.</footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
```

- [ ] **Step 7: Style the new elements** — in `apps/desktop/src/style.css`, remove rules used only by removed markup (`.notice`, `.profile-step`, `.aside-note`, `.runtime`, `.diff`, `progress`, `.percent`, `.changed`, `.before`, `.after`), keeping the palette and layout variables. Add rules for: `dl.profile` (two-column grid, `dd code` wraps with `overflow-wrap: anywhere`), `.problems` (warning-tinted box), `caption` (left-aligned eyebrow style), `.disposition` badge with one color per value (`apply` accent, `in-sync` muted, `blocked` danger, `capture` and `undeclared` neutral, `excluded` muted), `ol.steps` and `ol.progress-steps` (list rows; `li.running` accent, `li.ok` success, `li.failed` danger, `li.cancelled` muted), `.skipped` (small muted list). Match the existing file's variable names and spacing.

- [ ] **Step 8: Typecheck and run all desktop checks**

Run: `npm run typecheck -w apps/desktop && cd apps/desktop && npx tsx --test checks/*.spec.ts`
Expected: typecheck clean; all checks PASS.

- [ ] **Step 9: Look at it**

Run `npm run dev -w apps/desktop` and open http://127.0.0.1:1420 (browser preview: native actions disabled, so it shows the "Browser preview" state). Check the layout renders without console errors; screenshot it for the PR if the preview tools are available. The live app is checked in Task 8.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src apps/desktop/checks/controller.spec.ts
git commit -m "feat: show inspect, preview and cancellable apply in the desktop renderer"
```

---

### Task 8: Smoke on a temporary HOME, docs, and full verification

**Files:**
- Rewrite: `apps/desktop/scripts/smoke.mjs`
- Modify: `apps/desktop/README.md`, `apps/desktop/scripts/measure.mjs` (only if it sends v1 `inspect` records — update to v2)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Rewrite `apps/desktop/scripts/smoke.mjs`**

```js
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
    child = spawn(join(app, 'Contents/MacOS/nortuscc-desktop-validation'), ['--smoke'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
```

- [ ] **Step 2: Run the unpackaged smoke**

Run: `npm run resources -w apps/desktop && npm run smoke -w apps/desktop`
Expected: "Bundled backend smoke passed on temporary HOME …".

- [ ] **Step 3: Check `scripts/measure.mjs`**

Run: `grep -n "version\|command" apps/desktop/scripts/measure.mjs`. If it sends `{ version: 1, … command: 'inspect' }` or needs `NORTUSCC_FIXTURE_SESSION`, switch it to `version: 2` and a temporary HOME with a `state.json` recording the checkout (as the smoke does). It is a measurement tool, not run in CI; keep the change minimal.

- [ ] **Step 4: Rewrite `apps/desktop/README.md`**

Keep "Local setup" (update the title, the description, and `DESKTOP_BUN_LICENSE` instructions), the "Backend runtime size" section unchanged, and replace the rest:

- Title `# Nortuscc desktop`; first paragraph: the app inspects this machine through `@nortuscc/machine`, previews a plan, applies it with backups and can cancel. It wires in the domains listed in `backend/domains.ts`; config (#55), integrations (#56) and skills (#57) join as they merge.
- **Verification**: `npm run resources -w apps/desktop`, `npm test -w apps/desktop`, `npm run test:bun -w apps/desktop`, `npm run typecheck -w apps/desktop`, `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`, `npm run smoke -w apps/desktop`; what each covers (protocol, login PATH, session with fake domains, stdio framing/busy/cancel/STALE/shutdown/lock takeover/large reports, controller ordering, Rust envelope and lifecycle, temporary-HOME smoke).
- **Release package**: `npm run desktop:build -w apps/desktop` then `npm run smoke -w apps/desktop -- "src-tauri/target/release/bundle/macos/Nortuscc.app"`. Resources live under `Contents/Resources/backend-runtime`.
- **Protocol v2**: JSON lines, records ≤ 1 MiB; the five requests and their results (table as in the spec); error codes; run events `{ version: 2, event: 'progress', runId, progress }` with `started`/`finished`/`done`/`cancelled`/`failed`; the reply to `apply` precedes its events; `apply` re-inspects and answers `stale` with a new preview; per-command timeouts (inspect and apply 60 s, preview 10 s, cancel 30 s, shutdown 5 s); one run at a time (`BUSY`); `cancel` finishes the current file step or interrupts an installer; shutdown, EOF and SIGTERM cancel first; the backend holds `<stateRoot>/apply.lock` during a run, which legacy CLI commands also take.
- **Paths**: the backend builds paths from HOME and `state.json`'s `repo` exactly as the CLI, with no fallback; a stale record reports `REPO_NOT_FOUND` with the recorded path. PATH comes from `$SHELL -ilc` once at startup (5 s timeout); failures and missing `npx`/`claude`/`codex` are probe failures in the report. Rust passes no paths; the renderer sends only item keys and plan ids.
- **Manual check** (macOS has no Tauri WebDriver): open the `.app`, inspect, deselect an item, preview, apply, cancel a long run, restart the backend, and close the window during a run; then confirm no `apply.lock` remains in `~/.config/nortuscc`.

- [ ] **Step 5: Full verification**

```bash
npm ci
npm run typecheck
npm test; git status --short   # restore skills-manifest.txt if changed
npm run test:packages
npm test -w apps/desktop
npm run test:bun -w apps/desktop
npm run typecheck -w apps/desktop
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run smoke -w apps/desktop
PATH="$HOME/.cargo/bin:$PATH" npm run desktop:build -w apps/desktop
npm run smoke -w apps/desktop -- "src-tauri/target/release/bundle/macos/Nortuscc.app"
```

Expected: all pass. Record any pre-existing failure with evidence that it also fails on the base branch (`git worktree`-free check: `git log -1 --format=%H t3code/real-local-apply`, then rerun that single test against a checkout of it only if needed — or cite the README's known failure). If `desktop:build` fails for signing or environment reasons unrelated to this change, report it verbatim rather than working around it.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/scripts/smoke.mjs apps/desktop/README.md apps/desktop/scripts/measure.mjs
git commit -m "docs: document the real desktop app and smoke it on a temporary HOME"
```

---

## Self-Review Notes

- Spec coverage: protocol v2 requests, STALE, 1 MiB, per-command timeouts, allow-lists (Tasks 2, 5, 6); backend on `@nortuscc/machine` with environment paths and no fallback (Task 4); login-shell PATH probe and missing tools as probe failures (Tasks 3, 4); renderer profile panel, grouped inspect with state/disposition/provenance, deselect, preview with skipped reasons, apply with per-step progress, cancel and backup folder (Task 7); fixture code, smoke assertions and Rust tests replaced; Rust tests and smoke on a temporary HOME (Tasks 6, 8); issue comment: legacy writers take the lock (Task 1) and `RepoNotFound.recorded` is surfaced (Tasks 4–7).
- Not done here, by design: real domains (#55–#57). "Done when the packaged app applies to this machine and backs it up" completes once a domain lands; until then apply runs an empty plan on the real machine, and backups are verified with the fake domain.
