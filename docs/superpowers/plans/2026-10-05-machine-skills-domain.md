# Machine skills domain, undeclared probe and `update` cutover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Issue #57 (sub-issue 4/6 of #42). Give `@nortuscc/machine` a skills `Domain`, an undeclared-items probe, and the upstream update check, then cut `nortuscc update` over to TypeScript on top of them.

**Architecture:** The skills domain lives in `packages/machine/src/skills/`: pure manifest and update logic, Effect readers over `Fs`/`MachinePaths`, and the `npx skills` / `git` invocations through `Processes`. `inspect` reports store presence and per-agent exposure as `Observed` items; `steps` plans `apply` and a new `update` kind; `run` executes one step, backing up before anything is overwritten or removed. `write-manifest` writes only to `MachinePaths.repo`. `update`'s upstream check (`inspectUpdates`) produces the same `Observed` shape, so `src/commands/update.ts` runs it through `plan` and `execute` like every other command. The probe lives in `packages/machine/src/undeclared/`.

**Tech Stack:** Node 24+ (type stripping, no build), TypeScript (erasable syntax, `.ts` imports), `effect` 4.0.1, `node:test` + `node:assert/strict`, `git`, `npx skills`.

**Spec:** `docs/superpowers/specs/2026-10-05-machine-rebuild-design.md` (sections `@nortuscc/machine`, Domains, CLI, Migration, Testing). Package contract: `packages/machine/README.md`, `packages/machine/src/model.ts`, `packages/machine/src/run.ts`.

## Global Constraints

- Node 24+; new code is erasable-syntax TypeScript with `.ts` import extensions; legacy `.mjs` is only edited or deleted, never added.
- The one runtime dependency is `effect` (pinned 4.0.1). Use `node:`-prefixed builtin imports.
- Nothing below `pathsFromEnvironment` reads `process.env` or the home directory: package code takes `MachinePaths`, tests pass temporary paths.
- Machine access goes through `Fs`, `Processes` and `Backups`; `Processes` is argv only, never a shell.
- Nothing destructive runs without a backup to `<stateRoot>/backups/nortuscc-<stamp>/` first (skill folders under `skills/<name>`, no agent segment — the legacy layout).
- A domain's `steps` must be deterministic (no timestamps, random ids or machine paths in `summary`, `touches` or skip reasons).
- Preserve `update`'s flags, exit codes (0 clean, 1 dirty or failed, 2 usage/refused) and every text line the black-box tests assert.
- Tests: package specs in `packages/machine/checks/*.spec.ts` (`npm test -w packages/machine`), CLI tests in `test/*.test.{mjs,ts}` (`npm test`). Conventional-commit prefixes; commit after every task.
- After every root `npm test`, run `git status`; if `skills-manifest.txt` changed, `git checkout -- skills-manifest.txt`. Never commit it. Known pre-existing failures: `apps/desktop/checks/backend.spec.ts` teardown abort on Node 24.19; `test/fresh-machine.test.mjs` is intermittent.
- Stay inside the skills domain, the probe and `update`. Foundation edits are limited to Task 2's additive contract changes.

## Contract additions (Task 2; call out in the PR)

The fixed contract cannot express three things this issue needs. Each change is additive:

1. `Observed.target` becomes optional (`target?: Target`). A skill in the shared store belongs to no single agent. Per-agent facts (exposure) are separate items that do carry a target.
2. `PlanKind` gains `'update'` and `StepAction` gains `'update-skills'`. `update` adopts, refreshes and prunes, which is none of apply/uninstall/capture.
3. `Step` gains `targets?: ReadonlyArray<Target>`: the agents an installer step acts for (`--agent`). `run` receives only the step and the report, and the selection's targets are not in the report. `samePlan` compares it.

Plus one service method: `Fs.realPath(path)` (resolved path, `undefined` when absent or dangling). Exposure and the probe must follow links, and `Fs.stat` is `lstat`.

Skills steps name their skills in `touches` as store-relative paths `skills/<name>`. A skills step acts on exactly the skills its `touches` name. `run` reads the names back with `skillNamesOf(step)`.

## Review Focus

1. **Manifest written into the checkout.** A test or run whose `MachinePaths.repo` is a temp dir must never write the checkout's `skills-manifest.txt`. Expected: write-manifest writes `join(paths.repo, 'skills-manifest.txt')` only. Pinned in Task 7 (run test with a temp repo) and Task 1/10 (black-box asserts the checkout file's hash is unchanged).
2. **Unreadable agent directory.** If an agent's skill directory can't be read, the result is a probe error, never "this agent has no skills". Otherwise `update` would reinstall every skill. Pinned in Task 4 (`readExposure` error) and Task 7 (expose step makes no repair for an errored agent).
3. **Cancel mid-update (Ctrl-C).** The running installer is interrupted. No later step runs, so the manifest is not rewritten. The command exits non-zero and says what did not run. Pinned in Task 9.
4. **`--target claude`.** Installer calls carry only `--agent claude-code`, and exposure is judged for Claude only. Pinned in Task 7 (steps carry `targets`; run builds argv from them) and Task 9.
5. **Absent, malformed or wrongly-shaped `.skill-lock.json`, and dangling links in the store or `~/.claude/skills`.** Each degrades to "nothing known" or "absent" without crashing. Pinned in Task 4 (lock, store) and Task 8 (probe links).

---

## File map

| File | Responsibility |
| --- | --- |
| `packages/machine/src/model.ts`, `run.ts`, `fs.ts` | Task 2 additive contract changes |
| `packages/machine/src/skills/manifest.ts` | Pure: emit the manifest, regroup `DesiredConfig.skills`, rebuild groups from the lock, the shrink guard |
| `packages/machine/src/skills/store.ts` | Effects: lock path and read, installed names, per-agent exposure |
| `packages/machine/src/skills/installer.ts` | `npx skills add/update/remove` argv and running them through `Processes` |
| `packages/machine/src/skills/upstream.ts` | Pure update planning plus the `git` source check and `inspectUpdates(desired)` |
| `packages/machine/src/skills/domain.ts` | `skillsDomain`: inspect, steps (apply, update), run |
| `packages/machine/src/skills/index.ts` | Re-exports of the skills modules |
| `packages/machine/src/undeclared/probe.ts` | Pure undeclared derivation and the Claude-side readers; `probeUndeclared` |
| `packages/machine/src/index.ts` | Export the two new folders |
| `packages/machine/checks/skills-*.spec.ts`, `undeclared.spec.ts` | Package tests |
| `src/commands/update.ts` | The ported command: flags, report, picker, plan/execute, closing report, exit code |
| `test/update.test.ts` | Ported unit and orchestration tests for the command |
| `test/update-blackbox.test.ts` | Parity tests through `bin/nortuscc.mjs` |
| `bin/commands.mjs` | `PORTED = ['update']` |
| Deleted at cutover | `src/commands/update.mjs`, `src/skill-actions.mjs`, `src/skill-updates.mjs`, `src/git-trees.mjs` and their tests |

---

### Task 1: `update` black-box parity tests (against the legacy command)

These tests run the real `bin/nortuscc.mjs` with every `NORTUSCC_*` path in a temp dir, a real local `git` source and a fake `npx`. They must pass **before** the cutover (now, on legacy `update.mjs`) and after it (Task 10).

**Files:**
- Create: `test/update-blackbox.test.ts`

**Interfaces:**
- Produces: the parity suite Task 10 reruns unchanged.

- [ ] **Step 1: Write the test file**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(REPO, 'bin', 'nortuscc.mjs');
const CHECKOUT_MANIFEST = join(REPO, 'skills-manifest.txt');
const hashOf = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

// A local source repo `o/r` with three skills, plus the tree SHA of each folder.
function upstream() {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-upstream-'));
  git(dir, 'init', '-q');
  for (const name of ['stale', 'fresh', 'wizard']) {
    mkdirSync(join(dir, 's', name), { recursive: true });
    writeFileSync(join(dir, 's', name, 'SKILL.md'), `# ${name}\n`);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'skills');
  const tree = (name: string) => git(dir, 'rev-parse', `HEAD:s/${name}`);
  return { url: `file://${dir}`, trees: { stale: tree('stale'), fresh: tree('fresh'), wizard: tree('wizard') } };
}

// Models the installer's surface: the shared store, the lock, and Claude's links.
const FAKE_NPX = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
const argv = process.argv.slice(2);
appendFileSync(process.env.NORTUSCC_TEST_LOG, JSON.stringify(argv) + '\\n');
const verb = argv[2];
if (process.env.NORTUSCC_TEST_FAIL === verb) process.exit(1);
const store = process.env.NORTUSCC_AGENTS_DIR;
const lockPath = join(dirname(store), '.skill-lock.json');
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { skills: {} };
const upstream = JSON.parse(readFileSync(process.env.NORTUSCC_TEST_UPSTREAM, 'utf8'));
const names = (from) => { const out = []; for (let i = from; i < argv.length && !argv[i].startsWith('--'); i++) out.push(argv[i]); return out; };
const claudeLink = (n) => join(process.env.NORTUSCC_CLAUDE_DIR, 'skills', n);
if (verb === 'add') {
  const agents = argv.includes('--agent') ? names(argv.indexOf('--agent') + 1) : [];
  for (const n of names(argv.indexOf('--skill') + 1)) {
    mkdirSync(join(store, n), { recursive: true });
    lock.skills[n] = upstream[n];
    if (agents.includes('claude-code')) mkdirSync(claudeLink(n), { recursive: true });
  }
} else if (verb === 'update') {
  for (const n of names(3)) lock.skills[n] = { ...lock.skills[n], skillFolderHash: upstream[n].skillFolderHash };
} else if (verb === 'remove') {
  for (const n of names(3)) { rmSync(join(store, n), { recursive: true, force: true }); rmSync(claudeLink(n), { recursive: true, force: true }); delete lock.skills[n]; }
}
writeFileSync(lockPath, JSON.stringify(lock));
`;

type Machine = { env: NodeJS.ProcessEnv; repo: string; state: string; store: string; log: string };

// installed: name -> lock hash. Every installed skill is in the store and linked for Claude.
function machine(options: { installed: Record<string, string>; manifest: string; unreachable?: boolean; extraLock?: Record<string, object> }) {
  const up = upstream();
  const home = mkdtempSync(join(tmpdir(), 'nortuscc-update-bb-'));
  const m = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    store: join(home, '.agents', 'skills'), state: join(home, 'state'), log: join(home, 'npx.log'), bin: join(home, 'bin'),
  };
  for (const dir of [m.repo, m.claude, m.codex, m.store, m.bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(m.repo, 'skills-manifest.txt'), options.manifest);
  const sourceUrl = options.unreachable ? `file://${join(home, 'missing')}` : up.url;
  const entry = (name: string, hash: string) => ({ source: 'o/r', sourceUrl, skillPath: `s/${name}/SKILL.md`, skillFolderHash: hash });
  const lock: Record<string, object> = { ...options.extraLock };
  for (const [name, hash] of Object.entries(options.installed)) {
    mkdirSync(join(m.store, name), { recursive: true });
    writeFileSync(join(m.store, name, 'SKILL.md'), `# ${name}\n`);
    mkdirSync(join(m.claude, 'skills', name), { recursive: true });
    lock[name] = entry(name, hash);
  }
  writeFileSync(join(home, '.agents', '.skill-lock.json'), JSON.stringify({ skills: lock }));
  const upstreamFile = join(home, 'upstream.json');
  writeFileSync(upstreamFile, JSON.stringify(Object.fromEntries(
    Object.entries(up.trees).map(([name, hash]) => [name, entry(name, hash)]),
  )));
  writeFileSync(join(m.bin, 'npx'), FAKE_NPX);
  chmodSync(join(m.bin, 'npx'), 0o755);
  const env = {
    ...process.env,
    PATH: `${m.bin}${delimiter}${process.env.PATH}`,
    NORTUSCC_REPO_DIR: m.repo, NORTUSCC_CLAUDE_DIR: m.claude, NORTUSCC_CODEX_DIR: m.codex,
    NORTUSCC_AGENTS_DIR: m.store, NORTUSCC_STATE_DIR: m.state,
    NORTUSCC_TEST_LOG: m.log, NORTUSCC_TEST_UPSTREAM: upstreamFile,
  };
  return { ...m, env, trees: up.trees } as Machine & typeof m & { trees: typeof up.trees };
}

async function update(m: Machine, args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, 'update', ...args], { env: { ...m.env, ...extraEnv } });
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const calls = (m: Machine): string[][] =>
  existsSync(m.log) ? readFileSync(m.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const MANIFEST = '[o/r]\nfresh\nstale\n';
const checkoutBefore = hashOf(CHECKOUT_MANIFEST);

test('update --check reports outdated and current skills and runs nothing', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa', fresh: '' }, manifest: MANIFEST });
  // `fresh` must hold its real tree SHA to read as current.
  const lockPath = join(m.store, '..', '.skill-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.skills.fresh.skillFolderHash = (m as any).trees.fresh;
  writeFileSync(lockPath, JSON.stringify(lock));
  const result = await update(m, ['--check']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /current\s+1/);
  assert.match(result.stdout, /outdated\s+1\s+stale/);
  assert.match(result.stdout, /available\s+1\s+wizard/);
  assert.match(result.stdout, /Run: nortuscc update/);
  assert.deepEqual(calls(m), []);
});

test('update --yes backs up and refreshes the outdated skill only', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa' }, manifest: '[o/r]\nstale\n' });
  const result = await update(m, ['--yes']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(calls(m), [['-y', 'skills', 'update', 'stale', '--global', '--yes']]);
  const runs = readdirSync(join(m.state, 'backups'));
  assert.equal(runs.length, 1);
  assert.ok(existsSync(join(m.state, 'backups', runs[0]!, 'skills', 'stale', 'SKILL.md')));
  assert.match(result.stdout, new RegExp(`stale\\s+updated\\s+old0000 -> ${(m as any).trees.stale.slice(0, 7)}`));
  assert.match(result.stdout, /backed up -> /);
});

test('update --yes --add adopts the named skill for both agents and records it in the manifest', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa' }, manifest: '[o/r]\nstale\n' });
  const result = await update(m, ['--yes', '--add', 'wizard']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(calls(m).find((c) => c[2] === 'add'),
    ['-y', 'skills', 'add', 'o/r', '--skill', 'wizard', '--agent', 'claude-code', 'codex', '--global', '--yes']);
  assert.match(result.stdout, /wizard\s+added\s+o\/r/);
  assert.match(readFileSync(join(m.repo, 'skills-manifest.txt'), 'utf8'), /^wizard$/m);
  assert.match(result.stdout, /skills-manifest\.txt written/);
});

test('update --target claude installs for Claude only', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa' }, manifest: '[o/r]\nstale\n' });
  const result = await update(m, ['--target', 'claude', '--yes', '--add', 'wizard']);
  assert.equal(result.code, 0, result.stderr);
  const add = calls(m).find((c) => c[2] === 'add')!;
  assert.deepEqual(add.slice(add.indexOf('--agent'), add.indexOf('--global')), ['--agent', 'claude-code']);
});

test('update --yes --prune removes a skill gone upstream and drops it from the manifest', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa', ghost: 'g' }, manifest: '[o/r]\nghost\nstale\n' });
  const result = await update(m, ['--yes', '--prune']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(calls(m).some((c) => c.join(' ') === '-y skills remove ghost --global --yes'));
  assert.match(result.stdout, /ghost\s+removed/);
  const manifest = readFileSync(join(m.repo, 'skills-manifest.txt'), 'utf8');
  assert.doesNotMatch(manifest, /^ghost$/m);
  assert.match(manifest, /^\[o\/r\]\nstale$/m);
});

test('a gone skill left alone exits 1 and points at --prune', async () => {
  const m = machine({ installed: { ghost: 'g' }, manifest: '[o/r]\nghost\n' });
  const result = await update(m, ['--check']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /gone\s+1\s+ghost/);
  assert.match(result.stdout, /nortuscc update --prune/);
});

test('an unreachable source exits 1 and runs nothing', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa' }, manifest: '[o/r]\nstale\n', unreachable: true });
  const result = await update(m, ['--yes']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /unreachable\s+1\s+stale/);
  assert.deepEqual(calls(m), []);
});

test('a failing updater exits 1 and says so', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa' }, manifest: '[o/r]\nstale\n' });
  const result = await update(m, ['--yes'], { NORTUSCC_TEST_FAIL: 'update' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Something failed above/);
});

test('no terminal and no --yes refuses with exit 2', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa' }, manifest: '[o/r]\nstale\n' });
  const result = await update(m, []);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no terminal to choose on/);
  assert.deepEqual(calls(m), []);
});

test('--check with an action flag is a usage error', async () => {
  const m = machine({ installed: {}, manifest: MANIFEST });
  const result = await update(m, ['--check', '--prune']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--check is mutually exclusive/);
});

test("no run rewrites the checkout's own skills-manifest.txt", () => {
  assert.equal(hashOf(CHECKOUT_MANIFEST), checkoutBefore);
});
```

Notes for the implementer: the `--check` test fixes `fresh`'s hash after building the machine because the tree SHA is only known once the upstream exists. If a legacy assertion fails, read `src/commands/update.mjs` and fix the **test** to match legacy output. This suite pins legacy behaviour. The `--target claude` and `ghost` cases are the ones most likely to need a fixture tweak. Never weaken an assertion to "anything".

- [ ] **Step 2: Run against legacy**

Run: `node --test test/update-blackbox.test.ts`
Expected: all PASS (the command is still `src/commands/update.mjs`).

- [ ] **Step 3: Commit**

```bash
git add test/update-blackbox.test.ts
git commit -m "test: pin nortuscc update's behaviour with black-box tests"
```

---

### Task 2: Additive contract changes

**Files:**
- Modify: `packages/machine/src/model.ts`, `packages/machine/src/run.ts`, `packages/machine/src/fs.ts`
- Modify: `packages/machine/README.md`, `docs/superpowers/specs/2026-10-05-machine-rebuild-design.md` (Inspect/Plan sections: optional `target`, `update` kind, `update-skills`, `Step.targets`, `Fs.realPath`)
- Test: `packages/machine/checks/fs.spec.ts`, `packages/machine/checks/run.spec.ts`

**Interfaces:**
- Produces: `Observed.target?: Target`; `PlanKind = 'apply' | 'uninstall' | 'capture' | 'update'`; `StepAction` adds `'update-skills'`; `Step.targets?: ReadonlyArray<Target>`; `Fs.realPath: (path: string) => Effect<string | undefined, FsFailed>`.

- [ ] **Step 1: Failing tests**

Append to `packages/machine/checks/fs.spec.ts` (reuse that file's existing helper for running an `Fs` effect against `nodeFs`; if none exists, use `Effect.runPromise(Fs.use((fs) => fs.realPath(p)).pipe(Effect.provide(nodeFs)))`):

```ts
test('realPath follows links and reads a dangling or absent path as undefined', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'machine-realpath-'));
  mkdirSync(join(dir, 'target'));
  symlinkSync(join(dir, 'target'), join(dir, 'link'));
  symlinkSync(join(dir, 'gone'), join(dir, 'dangling'));
  const real = (p: string) => Effect.runPromise(Fs.use((fs) => fs.realPath(p)).pipe(Effect.provide(nodeFs)));
  assert.equal(await real(join(dir, 'link')), realpathSync(join(dir, 'target')));
  assert.equal(await real(join(dir, 'dangling')), undefined);
  assert.equal(await real(join(dir, 'absent')), undefined);
});
```

Append to `packages/machine/checks/run.spec.ts`:

```ts
test('samePlan compares step targets', () => {
  const a: Plan = { kind: 'update', steps: [{ ...step('a'), targets: ['claude'] }], skipped: [] };
  assert.equal(samePlan(a, { ...a, steps: [{ ...step('a'), targets: ['claude'] }] }), true);
  assert.equal(samePlan(a, { ...a, steps: [{ ...step('a'), targets: ['claude', 'codex'] }] }), false);
  assert.equal(samePlan(a, { ...a, steps: [step('a')] }), false);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -w packages/machine`
Expected: FAIL (`realPath` is not a function; `'update'` is not a `PlanKind` at typecheck; samePlan ignores targets).

- [ ] **Step 3: Implement**

`model.ts`:

```ts
export type Observed = {
  readonly key: string;
  readonly domain: DomainName;
  // Absent for an item no single agent owns, such as a skill in the shared store.
  readonly target?: Target;
  ...
};

export type PlanKind = 'apply' | 'uninstall' | 'capture' | 'update';
export type StepAction =
  | 'write-file' | 'merge-keys' | 'restore' | 'remove' | 'capture-file' | 'write-manifest' | 'install-integration' | 'install-skills'
  | 'update-skills';

export type Step = {
  ...
  // The agents an installer step acts for, when its domain is shared between agents (skills).
  readonly targets?: ReadonlyArray<Target>;
};
```

`run.ts` `sameStep` gains:

```ts
  && (a.targets ?? []).length === (b.targets ?? []).length
  && (a.targets === undefined) === (b.targets === undefined)
  && (a.targets ?? []).every((t, i) => t === b.targets![i])
```

`fs.ts`: add to the service type

```ts
    // Where `path` resolves after following every link; undefined when it, or a link's target, is absent.
    readonly realPath: (path: string) => Effect.Effect<string | undefined, FsFailed>;
```

and to `nodeFs`:

```ts
  realPath: (path) => attempt('realpath', path, () => realpath(path).catch((err) => {
    if (absent(err)) return undefined;
    throw err;
  })),
```

Then `grep -rn "\.target" packages/machine/src apps/desktop/src 2>/dev/null` and fix any type error the optional `target` causes (`npm run typecheck`).

README: add one bullet under the domain bullet: "`Observed.target` is absent for agent-neutral items (shared skills); `Step.targets` names the agents an installer step acts for. `update` is a plan kind of its own (adopt, refresh, prune skills)." Spec: mirror the same three changes in the `Observed` block, the Plan bullets and the Services `Fs` list.

- [ ] **Step 4: Verify**

Run: `npm test -w packages/machine && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/machine docs/superpowers/specs/2026-10-05-machine-rebuild-design.md
git commit -m "feat: let the machine model express shared skills and the update plan"
```

---

### Task 3: Manifest logic (pure)

**Files:**
- Create: `packages/machine/src/skills/manifest.ts`, `packages/machine/src/skills/index.ts`
- Modify: `packages/machine/src/index.ts` (add `export * from './skills/index.ts';`)
- Test: `packages/machine/checks/skills-manifest.spec.ts` (port the `emitManifest`, `groupsFromLock`, `installedGroups` cases from `test/skills.test.mjs` and the `manifestOutcome` cases from `test/update.test.mjs`)

**Interfaces:**
- Consumes: `SkillGroup`, `ResolvedSkill` from `@nortuscc/profile-engine`.
- Produces:
  - `MANIFEST_FILE = 'skills-manifest.txt'`
  - `type SkillLock = { readonly skills: Readonly<Record<string, unknown>> }`
  - `sourceOf(meta: unknown): string | null`
  - `emitManifest(groups: ReadonlyArray<SkillGroup>): string`
  - `groupsOf(skills: ReadonlyArray<ResolvedSkill>): SkillGroup[]`
  - `groupsFromLock(lock: SkillLock): SkillGroup[]`
  - `installedGroups(lock: SkillLock, installed: ReadonlyArray<string>, declared?: ReadonlyArray<SkillGroup>): SkillGroup[]`
  - `manifestOutcome(input: { before: ReadonlyArray<SkillGroup>; groups: ReadonlyArray<SkillGroup>; prunedNames?: ReadonlyArray<string> }): { write: boolean; reason: string }`

- [ ] **Step 1: Failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResolvedSkill } from '@nortuscc/profile-engine';
import { emitManifest, groupsFromLock, groupsOf, installedGroups, manifestOutcome } from '../src/index.ts';

const g = (source: string, skills: string[], extra: { exact?: boolean; optional?: boolean } = {}) =>
  ({ source, skills, exact: extra.exact ?? false, optional: extra.optional ?? false });
const skill = (name: string, source: string, extra: Partial<ResolvedSkill> = {}): ResolvedSkill =>
  ({ name, source, exact: false, optional: false, install: true, from: { layer: 'base', source: 'skills-manifest.txt' }, ...extra });

test('emitManifest writes the legacy header and markers byte for byte', () => {
  assert.equal(emitManifest([g('a/b', ['x', 'y'], { exact: true }), g('c/d', ['z'], { optional: true })]),
    '# Shared and optional skills, grouped by the repo they install from.\n'
    + '# Regenerate with: nortuscc capture\n'
    + '# Install with:    nortuscc apply --install\n'
    + "# A source marked 'exact' is limited to the skills listed under it.\n"
    + '# A source marked optional is offered unchecked and only installed when selected.\n\n'
    + '[a/b] exact\nx\ny\n\n[c/d] optional\nz\n');
});

test('groupsOf regroups resolved skills by source in first-seen order', () => {
  assert.deepEqual(groupsOf([skill('x', 'a/b', { exact: true }), skill('z', 'c/d'), skill('y', 'a/b', { exact: true })]),
    [g('a/b', ['x', 'y'], { exact: true }), g('c/d', ['z'])]);
});

test('groupsFromLock ignores entries without a string source and sorts by code point', () => {
  assert.deepEqual(groupsFromLock({ skills: { b: { source: 'z/z' }, a: { source: 'B/b' }, c: { source: 5 }, d: 'x' } }),
    [g('B/b', ['a']), g('z/z', ['b'])]);
});

test('installedGroups keeps exact markers, drops uninstalled names and retains optional declarations', () => {
  const lock = { skills: { x: { source: 'a/b' }, gone: { source: 'a/b' }, o: { source: 'o/p' } } };
  assert.deepEqual(installedGroups(lock, ['x', 'o'], [g('a/b', ['x'], { exact: true }), g('o/p', ['o', 'later'], { optional: true })]),
    [g('a/b', ['x'], { exact: true }), g('o/p', ['later', 'o'], { optional: true })]);
});

test('manifestOutcome refuses an adopt that masks a miss', () => {
  const out = manifestOutcome({ before: [g('a/b', ['x', 'y'])], groups: [g('a/b', ['x', 'w'])] });
  assert.equal(out.write, false);
  assert.match(out.reason, /would drop 1 entr\(ies\) \(y\)/);
});

test('manifestOutcome writes a shrink the prune explains, and refuses an empty manifest', () => {
  assert.deepEqual(manifestOutcome({ before: [g('a/b', ['x', 'y'])], groups: [g('a/b', ['x'])], prunedNames: ['y'] }),
    { write: true, reason: '1 skill(s)' });
  assert.equal(manifestOutcome({ before: [g('a/b', ['y'])], groups: [], prunedNames: ['y'] }).write, false);
});
```

Port the remaining cases from `test/skills.test.mjs` (`parseManifest` is not ported: the engine owns parsing) and every `manifestOutcome` case from `test/update.test.mjs` into the same file, in this style.

- [ ] **Step 2: Run, verify failure**

Run: `npm test -w packages/machine`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement `packages/machine/src/skills/manifest.ts`**

```ts
import type { ResolvedSkill, SkillGroup } from '@nortuscc/profile-engine';

export const MANIFEST_FILE = 'skills-manifest.txt';

// The installer's `.skill-lock.json`, reduced to its `skills` record; owned by the third-party CLI.
export type SkillLock = { readonly skills: Readonly<Record<string, unknown>> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// A lock entry's source when it is a non-empty string; anything else means "authored locally".
export const sourceOf = (meta: unknown): string | null =>
  isRecord(meta) && typeof meta.source === 'string' && meta.source ? meta.source : null;

// The manifest text, byte-identical to the legacy writer so a capture produces no spurious diff.
export function emitManifest(groups: ReadonlyArray<SkillGroup>): string {
  const head = '# Shared and optional skills, grouped by the repo they install from.\n'
    + '# Regenerate with: nortuscc capture\n'
    + '# Install with:    nortuscc apply --install\n'
    + "# A source marked 'exact' is limited to the skills listed under it.\n"
    + '# A source marked optional is offered unchecked and only installed when selected.\n\n';
  return head + groups
    .map((g) => `[${g.source}]${g.exact ? ' exact' : ''}${g.optional ? ' optional' : ''}\n${g.skills.join('\n')}\n`)
    .join('\n');
}

// The manifest's groups as the engine resolved them, in first-seen source order.
export function groupsOf(skills: ReadonlyArray<ResolvedSkill>): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const s of skills) {
    const group = groups.get(s.source) ?? { source: s.source, skills: [], exact: s.exact, optional: s.optional };
    group.skills.push(s.name);
    groups.set(s.source, group);
  }
  return [...groups.values()];
}

// What the lock says was installed, by source. Entries without a source are local and never listed.
export function groupsFromLock(lock: SkillLock): SkillGroup[] {
  const bySource = new Map<string, string[]>();
  for (const [name, meta] of Object.entries(lock.skills)) {
    const source = sourceOf(meta);
    if (!source) continue;
    bySource.set(source, [...(bySource.get(source) ?? []), name]);
  }
  return [...bySource.entries()]
    .sort(([a], [b]) => byCodePoint(a, b))
    .map(([source, skills]) => ({ source, skills: skills.sort(byCodePoint), exact: false, optional: false }));
}

// The manifest a machine implies: lock sources filtered to what is present, keeping the declared
// manifest's `exact` markers and its optional declarations (an optional skill may never be installed here).
export function installedGroups(
  lock: SkillLock,
  installed: ReadonlyArray<string>,
  declared: ReadonlyArray<SkillGroup> = [],
): SkillGroup[] {
  const present = new Set(installed);
  const exact = new Set(declared.filter((g) => g.exact).map((g) => g.source));
  const groups = groupsFromLock(lock)
    .map((group) => ({ ...group, skills: group.skills.filter((n) => present.has(n)), exact: exact.has(group.source) }))
    .filter((group) => group.skills.length > 0);
  for (const declaration of declared.filter((g) => g.optional)) {
    const group = groups.find((g) => g.source === declaration.source);
    if (group) {
      group.optional = true;
      group.skills = [...new Set([...group.skills, ...declaration.skills])].sort(byCodePoint);
    } else {
      groups.push({ ...declaration, skills: [...declaration.skills] });
    }
  }
  return groups.sort((a, b) => byCodePoint(a.source, b.source));
}

// The shrink guard: compares sets, so an adopt cannot mask a miss. Every name the current manifest lists
// that neither survives nor was pruned is one this machine merely lacks, and must not be dropped for everyone.
export function manifestOutcome(input: {
  readonly before: ReadonlyArray<SkillGroup>;
  readonly groups: ReadonlyArray<SkillGroup>;
  readonly prunedNames?: ReadonlyArray<string>;
}): { write: boolean; reason: string } {
  const afterCount = input.groups.reduce((n, g) => n + g.skills.length, 0);
  if (afterCount === 0) return { write: false, reason: 'would leave the manifest empty; nothing was written' };
  const after = new Set(input.groups.flatMap((g) => g.skills));
  const pruned = new Set(input.prunedNames ?? []);
  const missing = input.before.flatMap((g) => g.skills).filter((n) => !after.has(n) && !pruned.has(n));
  if (missing.length) {
    return {
      write: false,
      reason: `would drop ${missing.length} entr(ies) (${missing.join(', ')}) not accounted for by the`
        + " prune; run 'nortuscc capture --allow-shrink' if that is intended",
    };
  }
  return { write: true, reason: `${afterCount} skill(s)` };
}
```

`packages/machine/src/skills/index.ts`: `export * from './manifest.ts';`. Later tasks append their modules here.

- [ ] **Step 4: Verify**

Run: `npm test -w packages/machine && npm run typecheck -w packages/machine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/machine
git commit -m "feat: port skill manifest regeneration and its shrink guard to the machine package"
```

---

### Task 4: Store, exposure and installer

**Files:**
- Create: `packages/machine/src/skills/store.ts`, `packages/machine/src/skills/installer.ts`
- Modify: `packages/machine/src/skills/index.ts`
- Test: `packages/machine/checks/skills-store.spec.ts` (port `test/skill-links.test.mjs`, the `skillExposure` cases of `test/skills.test.mjs`, and the argv cases of `test/skills-cli.test.mjs`)

**Interfaces:**
- Consumes: `Fs`, `MachinePaths`, `Processes`, `type Command` from the package; `SkillLock` (Task 3).
- Produces (store.ts):
  - `skillLockPath(paths: MachinePathsValue): string` = `join(dirname(paths.agentsSkills), '.skill-lock.json')`
  - `readSkillLock: Effect<SkillLock, never, Fs | MachinePaths>`: absent, unparseable or wrongly shaped all read as `{ skills: {} }`
  - `installedSkillNames: Effect<string[], FsFailed, Fs | MachinePaths>`: sorted directories and symlinks in the store (`[]` when absent)
  - `agentSkillsDirs(paths, target): string[]`: claude → `[<claude>/skills]`; codex → `[agentsSkills, <codex>/skills]`
  - `readExposure(targets: ReadonlyArray<Target>): Effect<{ list: Partial<Record<Target, string[]>>; errors: string[] }, never, Fs | MachinePaths>`: a failed read is an error and the target is left out of `list`
  - `skillExposure(input: { names: ReadonlyArray<string>; targets: ReadonlyArray<Target>; list: Partial<Record<Target, ReadonlyArray<string>>> }): { exposed: string[]; partial: { name: string; missing: Target[] }[]; missing: string[] }`
- Produces (installer.ts):
  - `SKILL_AGENTS: Record<Target, string>` = `{ claude: 'claude-code', codex: 'codex' }`
  - `addCommand(input: { source: string; skills: ReadonlyArray<string>; targets: ReadonlyArray<Target> }): Command`
  - `updateCommand(names: ReadonlyArray<string>): Command`, `removeCommand(names: ReadonlyArray<string>): Command`
  - `runInstaller(command: Command): Effect<StepResult, LaunchFailed, Processes>`: `{ ok: code === 0, note: '' | 'npx exited with <code>' }`

- [ ] **Step 1: Failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import {
  addCommand, installedSkillNames, machinePaths, nodeFs, Processes, readExposure, readSkillLock, removeCommand,
  runInstaller, skillExposure, updateCommand, type Command,
} from '../src/index.ts';

export const skillsMachine = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-skills-'));
  const paths = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot: join(home, 'state'), backups: join(home, 'state', 'backups'),
  };
  const layer = Layer.mergeAll(machinePaths(paths), nodeFs);
  const run = <A, E>(effect: Effect.Effect<A, E, any>) => Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>);
  return { home, paths, layer, run };
};

test('a missing, unparseable or misshapen lock reads as empty', async () => {
  const { paths, run } = skillsMachine();
  assert.deepEqual(await run(readSkillLock), { skills: {} });
  mkdirSync(join(paths.agentsSkills, '..'), { recursive: true });
  for (const text of ['{nope', '[]', '{"skills": 3}']) {
    writeFileSync(join(paths.agentsSkills, '..', '.skill-lock.json'), text);
    assert.deepEqual(await run(readSkillLock), { skills: {} });
  }
});

test('installed names are the store directories and links, sorted', async () => {
  const { paths, run } = skillsMachine();
  assert.deepEqual(await run(installedSkillNames), []);
  mkdirSync(join(paths.agentsSkills, 'b'), { recursive: true });
  mkdirSync(join(paths.agentsSkills, 'a'));
  writeFileSync(join(paths.agentsSkills, 'README'), 'not a skill');
  symlinkSync(join(paths.home ?? paths.repo, 'elsewhere'), join(paths.agentsSkills, 'c'));
  assert.deepEqual(await run(installedSkillNames), ['a', 'b', 'c']);
});

test('exposure follows links, ignores dot entries and counts the store for Codex', async () => {
  const { paths, run } = skillsMachine();
  mkdirSync(join(paths.agentsSkills, 'tdd'), { recursive: true });
  mkdirSync(join(paths.claude, 'skills'), { recursive: true });
  symlinkSync(join(paths.agentsSkills, 'tdd'), join(paths.claude, 'skills', 'tdd'));
  symlinkSync(join(paths.agentsSkills, 'removed'), join(paths.claude, 'skills', 'removed'));
  mkdirSync(join(paths.codex, 'skills', '.system'), { recursive: true });
  assert.deepEqual(await run(readExposure(['claude', 'codex'])), { list: { claude: ['tdd'], codex: ['tdd'] }, errors: [] });
});

test('an unreadable agent directory is an error, never an empty list', async () => {
  const { paths, run } = skillsMachine();
  mkdirSync(join(paths.claude, 'skills'), { recursive: true });
  chmodSync(join(paths.claude, 'skills'), 0o000);
  try {
    const result = await run(readExposure(['claude']));
    assert.deepEqual(result.list, {});
    assert.match(result.errors[0]!, /could not read the skill directory for claude-code/);
  } finally {
    chmodSync(join(paths.claude, 'skills'), 0o755);
  }
});

test('skillExposure splits exposed, partial and missing', () => {
  assert.deepEqual(skillExposure({ names: ['a', 'b', 'c'], targets: ['claude', 'codex'], list: { claude: ['a', 'b'], codex: ['a'] } }),
    { exposed: ['a'], partial: [{ name: 'b', missing: ['codex'] }], missing: ['c'] });
});

test('installer argv: variadic names, explicit agents, global and non-interactive', () => {
  assert.deepEqual(addCommand({ source: 'o/r', skills: ['a', 'b'], targets: ['claude', 'codex'] }).args,
    ['-y', 'skills', 'add', 'o/r', '--skill', 'a', 'b', '--agent', 'claude-code', 'codex', '--global', '--yes']);
  assert.deepEqual(updateCommand(['a']).args, ['-y', 'skills', 'update', 'a', '--global', '--yes']);
  assert.deepEqual(removeCommand(['a']).args, ['-y', 'skills', 'remove', 'a', '--global', '--yes']);
});

test('runInstaller reports a non-zero exit as a failed result', async () => {
  const seen: Command[] = [];
  const fake = Layer.succeed(Processes, { run: (c) => Effect.sync(() => { seen.push(c); return { code: 3, stdout: '' }; }) });
  const result = await Effect.runPromise(runInstaller(updateCommand(['a'])).pipe(Effect.provide(fake)));
  assert.deepEqual(result, { ok: false, note: 'npx exited with 3' });
  assert.equal(seen[0]!.output, 'inherit');
});
```

(The `installedSkillNames` test's symlink target may be any absent path; replace `paths.home ?? paths.repo` with `home` from the fixture.) Skip the permission test when running as root: `if (process.getuid?.() === 0) return;`.

- [ ] **Step 2: Run, verify failure**

Run: `npm test -w packages/machine`. Expected: FAIL (exports missing).

- [ ] **Step 3: Implement `store.ts`**

```ts
import { dirname, join } from 'node:path';
import { Effect } from 'effect';
import { TARGETS, type Target } from '@nortuscc/profile-engine';
import { Fs } from '../fs.ts';
import { MachinePaths, type MachinePathsValue } from '../paths.ts';
import { SKILL_AGENTS } from './installer.ts';
import type { SkillLock } from './manifest.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A sibling of the store, so redirecting the store (NORTUSCC_AGENTS_DIR) redirects the lock too.
export const skillLockPath = (paths: MachinePathsValue) => join(dirname(paths.agentsSkills), '.skill-lock.json');

// The installer owns the lock; anything unreadable or misshapen degrades to "nothing known".
export const readSkillLock: Effect.Effect<SkillLock, never, Fs | MachinePaths> = Effect.gen(function* () {
  const fs = yield* Fs;
  const text = yield* fs.readText(skillLockPath(yield* MachinePaths)).pipe(Effect.orElseSucceed(() => undefined));
  if (text === undefined) return { skills: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    return { skills: isRecord(parsed) && isRecord(parsed.skills) ? parsed.skills : {} };
  } catch {
    return { skills: {} };
  }
});

// Skill folders (or links to them) in the shared store, sorted.
export const installedSkillNames = Effect.gen(function* () {
  const fs = yield* Fs;
  const store = (yield* MachinePaths).agentsSkills;
  const names = (yield* fs.list(store)) ?? [];
  const kept: string[] = [];
  for (const name of names) {
    const kind = (yield* fs.stat(join(store, name)))?.kind;
    if (kind === 'directory' || kind === 'symlink') kept.push(name);
  }
  return kept;
});

// Every directory an agent loads skills from. Codex reads the shared store itself; Claude only its own.
export const agentSkillsDirs = (paths: MachinePathsValue, target: Target): string[] =>
  target === 'codex' ? [paths.agentsSkills, join(paths.codex, 'skills')] : [join(paths.claude, 'skills')];

// Names an agent can load: non-dot entries that resolve, so a dangling link reads as absent.
const exposedSkillNames = (target: Target) => Effect.gen(function* () {
  const fs = yield* Fs;
  const names = new Set<string>();
  for (const dir of agentSkillsDirs(yield* MachinePaths, target)) {
    for (const name of (yield* fs.list(dir)) ?? []) {
      if (name.startsWith('.')) continue;
      if ((yield* fs.realPath(join(dir, name))) !== undefined) names.add(name);
    }
  }
  return [...names].sort();
});

// Per-agent loadable names. A directory that cannot be read is an error and its agent is left out,
// so a failed read can never look like "this agent has no skills" and trigger a reinstall of all of them.
export const readExposure = (targets: ReadonlyArray<Target>) => Effect.gen(function* () {
  const list: Partial<Record<Target, string[]>> = {};
  const errors: string[] = [];
  for (const target of targets) {
    const result = yield* Effect.result(exposedSkillNames(target));
    if (result._tag === 'Success') list[target] = result.success;
    else errors.push(`could not read the skill directory for ${SKILL_AGENTS[target]}: ${result.failure.message}`);
  }
  return { list, errors };
});

// Classifies names by how many of `targets` can load them; an agent without a list sees nothing.
export function skillExposure(input: {
  readonly names: ReadonlyArray<string>;
  readonly targets: ReadonlyArray<Target>;
  readonly list: Partial<Record<Target, ReadonlyArray<string>>>;
}) {
  const exposed: string[] = [];
  const partial: { name: string; missing: Target[] }[] = [];
  const missing: string[] = [];
  for (const name of input.names) {
    const lacking = input.targets.filter((t) => !(input.list[t] ?? []).includes(name));
    if (lacking.length === 0) exposed.push(name);
    else if (lacking.length === input.targets.length) missing.push(name);
    else partial.push({ name, missing: lacking });
  }
  return { exposed, partial, missing };
}

export { TARGETS };
```

Check the v4 `Result` shape before relying on `_tag`/`success`/`failure`: `grep -n "interface Success\|interface Failure" node_modules/effect/dist/Result.d.ts`. If the fields differ, use `Result.isSuccess(result)` and the documented field names. Drop the trailing `export { TARGETS }` if unused.

- [ ] **Step 4: Implement `installer.ts`**

```ts
import { Effect } from 'effect';
import type { Target } from '@nortuscc/profile-engine';
import { Processes, type Command } from '../processes.ts';
import type { StepResult } from '../model.ts';

// The only place `npx skills` is spelled. nortuscc's target names are not the installer's agent ids.
export const SKILL_AGENTS: Record<Target, string> = { claude: 'claude-code', codex: 'codex' };

// `--skill` and `--agent` are variadic: names go in space-separated (a comma-joined value is one literal
// name). Agents are always explicit, so the installer never guesses which agents get the skill.
export const addCommand = (input: { source: string; skills: ReadonlyArray<string>; targets: ReadonlyArray<Target> }): Command => ({
  cmd: 'npx',
  args: ['-y', 'skills', 'add', input.source, '--skill', ...input.skills,
    ...(input.targets.length ? ['--agent', ...input.targets.map((t) => SKILL_AGENTS[t])] : []), '--global', '--yes'],
  output: 'inherit',
});

export const updateCommand = (names: ReadonlyArray<string>): Command =>
  ({ cmd: 'npx', args: ['-y', 'skills', 'update', ...names, '--global', '--yes'], output: 'inherit' });

export const removeCommand = (names: ReadonlyArray<string>): Command =>
  ({ cmd: 'npx', args: ['-y', 'skills', 'remove', ...names, '--global', '--yes'], output: 'inherit' });

// The installer's own output is inherited, so a failure explains itself there; the note only names the exit.
export const runInstaller = (command: Command): Effect.Effect<StepResult, import('../errors.ts').LaunchFailed, Processes> =>
  Effect.gen(function* () {
    const { code } = yield* (yield* Processes).run(command);
    return code === 0 ? { ok: true, note: '' } : { ok: false, note: `npx exited with ${code}` };
  });
```

(Use a normal `import type { LaunchFailed } from '../errors.ts'` rather than the inline `import()` type.) Append `export * from './store.ts'; export * from './installer.ts';` to `skills/index.ts`.

- [ ] **Step 5: Verify and commit**

Run: `npm test -w packages/machine && npm run typecheck -w packages/machine`. Expected: PASS.

```bash
git add packages/machine
git commit -m "feat: read the skill store, lock and per-agent exposure through machine services"
```

---

### Task 5: Upstream check and `inspectUpdates`

**Files:**
- Create: `packages/machine/src/skills/upstream.ts`
- Modify: `packages/machine/src/skills/index.ts`
- Test: `packages/machine/checks/skills-upstream.spec.ts` (port `test/skill-updates.test.mjs` for the pure functions; `test/git-trees.test.mjs` for the git check, using real local repos)

**Interfaces:**
- Consumes: `readSkillLock`, `installedSkillNames` (Task 4); `SkillLock`, `sourceOf` (Task 3); `Processes`, `Fs`, `MachinePaths`.
- Produces:
  - `short(sha: string | null | undefined): string`: first 7 chars, else `'unknown'`
  - `skillFolder(skillPath: string): string`
  - `type UpdatableSkill = { name; source; sourceUrl; path; hash: string | null }`; `updatableSkills(lock, installed): UpdatableSkill[]`
  - `type SourceCheck = { source; sourceUrl; paths: string[]; exact: boolean }`; `sourcesOf(entries, exact: ReadonlySet<string>): SourceCheck[]`
  - `type Upstream = { trees: Map<string, string | null>; skillPaths: string[] }`
  - `type UpdatePlan = { current: string[]; outdated: { name; source; from: string | null; to: string }[]; gone: { name; source; path }[]; unknown: { name; source }[]; local: string[]; available: { name; source }[] }`
  - `planUpdates(input: { lock; installed; remoteTrees: Map<string, Map<string, string | null>> }): Omit<UpdatePlan, 'available'>`
  - `upstreamSkills(skillPaths: string[]): { path; name }[]`; `availableSkills(input: { upstreamBySource: Map<string, { name }[]>; installed }): { name; source }[]`
  - `inspectSource(sourceUrl: string, paths: ReadonlyArray<string>, discover: boolean): Effect<Upstream | null, never, Processes | Fs | MachinePaths>`
  - `checkUpdates(desired: DesiredConfig): Effect<UpdatePlan, FsFailed, Processes | Fs | MachinePaths>`
  - `updateItems(plan: UpdatePlan, desired: DesiredConfig): Observed[]`; key `skill:<name>`, domain `'skills'`, no target. State and disposition: `current`→`in-sync`, `outdated`→`apply` (note `<from7> -> <to7>`), `gone`→`apply` (note `gone upstream`), `available`→`excluded` (note `available`), `unknown`→`blocked` (note `source unreachable`), `local`→`excluded` (note `no recorded source`). `group` = source (`''` for local); `label` = name; `from` = the declared skill's `from` when the manifest names it. Order: current, outdated, gone, unknown, local, available.
  - `inspectUpdates(desired): Effect<{ items: Observed[]; probeErrors: string[] }, never, ...>`: `checkUpdates` then `updateItems`; an `FsFailed` becomes one probe error and no items.

- [ ] **Step 1: Failing tests**

Port every case in `test/skill-updates.test.mjs` (`skillFolder`, `updatableSkills`, `sourcesOf`, `planUpdates`, `upstreamSkills`, `availableSkills`), converting the call shape from `installedNames` to `installed`. Add:

```ts
import { execFileSync } from 'node:child_process';
// ...plus the skillsMachine fixture from skills-store.spec.ts (copy it; spec files do not import each other)

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

function sourceRepo(home: string) {
  const dir = join(home, 'upstream');
  mkdirSync(dir);
  git(dir, 'init', '-q');
  for (const p of ['s/a', 's/b', 's/b/nested']) {
    mkdirSync(join(dir, p), { recursive: true });
    writeFileSync(join(dir, p, 'SKILL.md'), p);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'i');
  return { url: `file://${dir}`, tree: (p: string) => git(dir, 'rev-parse', `HEAD:${p}`) };
}

test('inspectSource reads folder trees and every SKILL.md, and cleans up its clone', async () => {
  const m = skillsMachine();
  const src = sourceRepo(m.home);
  const layer = Layer.mergeAll(m.layer, nodeProcesses());
  const found = await Effect.runPromise(inspectSource(src.url, ['s/a', 's/missing', '.'], true).pipe(Effect.provide(layer)));
  assert.equal(found!.trees.get('s/a'), src.tree('s/a'));
  assert.equal(found!.trees.get('s/missing'), null);
  assert.equal(found!.trees.get('.'), src.tree(''));   // HEAD: is the root tree
  assert.deepEqual(found!.skillPaths.sort(), ['s/a/SKILL.md', 's/b/SKILL.md', 's/b/nested/SKILL.md']);
  assert.deepEqual(readdirSync(join(m.paths.stateRoot, 'tmp')), []);
});

test('an exact source is not listed, and an unreachable one is null', async () => {
  const m = skillsMachine();
  const src = sourceRepo(m.home);
  const layer = Layer.mergeAll(m.layer, nodeProcesses());
  const pinned = await Effect.runPromise(inspectSource(src.url, ['s/a'], false).pipe(Effect.provide(layer)));
  assert.deepEqual(pinned!.skillPaths, []);
  assert.equal(await Effect.runPromise(inspectSource(`file://${join(m.home, 'nope')}`, ['s/a'], true).pipe(Effect.provide(layer))), null);
});

test('inspectUpdates turns the plan into skill items', async () => {
  // store: a (current), stale (outdated); lock sources point at the local repo; manifest declares a
  // ...build lock + store in m.paths, desired.skills = [a from base]; assert keys, states, dispositions,
  // the outdated note '<7> -> <7>', the available item for b, and that `from` is set only for a.
});
```

Write out the last test fully. Lock: `{ a: {source:'o/r', sourceUrl: src.url, skillPath:'s/a/SKILL.md', skillFolderHash: src.tree('s/a')}, stale: {source:'o/r', sourceUrl: src.url, skillPath:'s/b/SKILL.md', skillFolderHash:'old0000'} }`. Store folders: `a` and `stale`. `desired.skills` declares `a` only. Expected items, in order:
- `skill:a` current/in-sync, with `from` set
- `skill:stale` outdated/apply, note `old0000 -> <first 7 of tree(s/b)>`, no `from`
- `skill:b` available/excluded: the upstream folder `s/b` installs as `b`, which is not installed here (the lock calls it `stale`)
- **no** item for `nested`: `s/b/nested` sits under a folder that already holds a SKILL.md, so `upstreamSkills` drops it. This pins the nesting rule.

- [ ] **Step 2: Run, verify failure** (`npm test -w packages/machine`).

- [ ] **Step 3: Implement `upstream.ts`**

Port `skillFolder`, `updatableSkills`, `sourcesOf`, `planUpdates`, `upstreamSkills`, `availableSkills` from `src/skill-updates.mjs` verbatim in TypeScript. Rename `installedNames` to `installed`. Keep each legacy comment that states a rule (nesting, first-source-wins, missing hash ⇒ outdated, unreachable ⇒ unknown). Then:

```ts
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
// ...

const lsTree = (dir: string): Command => ({ cmd: 'git', args: ['ls-tree', '-r', '-t', '-z', 'HEAD'], cwd: dir, output: 'capture' });

// One shallow, blob-less clone per source answers both questions: each known folder's tree SHA, and
// (unless the source is exact) every SKILL.md it offers. ls-tree is silent about missing paths, so a
// skill gone upstream reads as null without git complaining on the terminal. null: not reachable.
export const inspectSource = (sourceUrl: string, paths: ReadonlyArray<string>, discover: boolean) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const processes = yield* Processes;
    const dir = join((yield* MachinePaths).stateRoot, 'tmp', `trees-${randomUUID()}`);
    const body = Effect.gen(function* () {
      const cloned = yield* processes.run({
        cmd: 'git', args: ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--quiet', sourceUrl, dir], output: 'capture',
      });
      if (cloned.code !== 0) return null;
      const listed = yield* processes.run(lsTree(dir));
      if (listed.code !== 0) return null;
      const treeAt = new Map<string, string>();
      const skillPaths: string[] = [];
      for (const record of listed.stdout.split('\0').filter(Boolean)) {
        const [meta, path] = record.split('\t') as [string, string];
        const [, type, sha] = meta.split(' ');
        if (type === 'tree') treeAt.set(path, sha!);
        else if (type === 'blob' && /(^|\/)SKILL\.md$/.test(path)) skillPaths.push(path);
      }
      if (paths.includes('.')) {
        const root = yield* processes.run({ cmd: 'git', args: ['rev-parse', 'HEAD^{tree}'], cwd: dir, output: 'capture' });
        if (root.code === 0) treeAt.set('.', root.stdout.trim());
      }
      const trees = new Map(paths.map((p) => [p, treeAt.get(p) ?? null] as const));
      return { trees, skillPaths: discover ? skillPaths : [] };
    });
    return yield* body.pipe(
      Effect.catch(() => Effect.succeed(null)),
      Effect.ensuring(fs.remove(dir).pipe(Effect.ignore)),
    );
  });
```

`checkUpdates(desired)`: read the lock and installed names. Compute `exact = new Set(desired.skills.filter((s) => s.exact).map((s) => s.source))`. For each `sourcesOf(updatableSkills(lock, installed), exact)` run `inspectSource(url, paths, !pinned)` **sequentially**. Fill `remoteTrees` (by url) and `upstreamBySource` (by source, via `upstreamSkills`). Return `{ ...planUpdates(...), available: availableSkills(...) }`.

`updateItems` and `inspectUpdates` as specified in Interfaces. Append `export * from './upstream.ts';` to `skills/index.ts`.

- [ ] **Step 4: Verify and commit**

Run: `npm test -w packages/machine && npm run typecheck -w packages/machine`. Expected: PASS.

```bash
git add packages/machine
git commit -m "feat: check skill sources upstream through Processes and report updates as items"
```

---

### Task 6: Skills domain `inspect`

**Files:**
- Create: `packages/machine/src/skills/domain.ts`
- Modify: `packages/machine/src/skills/index.ts`
- Test: `packages/machine/checks/skills-domain.spec.ts` (port the `reconcile` cases of `test/skills.test.mjs` as inspect cases)

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces: `inspectSkills(desired: DesiredConfig): Effect<{ items: Observed[]; probeErrors: string[] }, never, Fs | MachinePaths>`, later wired as `skillsDomain.inspect`. Items:
  - one per declared skill, key `skill:<name>`, no target, `group` = source, `label` = name, `from` = the skill's `from`:
    - installed → state `ok`, disposition `in-sync`
    - not installed, `install` → state `missing`, disposition `apply`
    - not installed, not `install` → state `missing`, disposition `excluded`, note `optional`
  - one per installed, undeclared skill: with a lock source → state `extra`, disposition `undeclared`, note `not in the manifest`, group = lock source; without → state `local`, disposition `excluded`, note `authored locally`, group `''`.
  - for every `ok` skill and each target in `TARGETS` that cannot load it: key `skill-link:<target>:<name>`, `target`, state `unlinked`, disposition `apply`, group = source, label = name, note `not loadable by <agent id>`. Exposure is read only when some skill is `ok`; its errors become probe errors.
  - a store that cannot be listed: one probe error `could not read <agentsSkills>: <message>`, every declared skill reads as missing.

- [ ] **Step 1: Failing tests**

```ts
const desiredWith = (skills: ResolvedSkill[]): DesiredConfig => ({ files: [], skills, integrations: [], allow: {}, issues: [] });

test('inspect reports ok, missing, optional, extra and local skills', async () => {
  const m = skillsMachine();
  for (const n of ['have', 'extra', 'mine']) mkdirSync(join(m.paths.agentsSkills, n), { recursive: true });
  writeFileSync(join(m.paths.agentsSkills, '..', '.skill-lock.json'),
    JSON.stringify({ skills: { have: { source: 'o/r' }, extra: { source: 'x/y' } } }));
  // Both agents see `have`, so no link items.
  mkdirSync(join(m.paths.claude, 'skills', 'have'), { recursive: true });
  const report = await m.run(inspectSkills(desiredWith([
    skill('have', 'o/r'), skill('want', 'o/r'), skill('maybe', 'o/r', { optional: true, install: false }),
  ])));
  assert.deepEqual(report.items.map((i) => [i.key, i.state, i.disposition, i.target]), [
    ['skill:have', 'ok', 'in-sync', undefined],
    ['skill:want', 'missing', 'apply', undefined],
    ['skill:maybe', 'missing', 'excluded', undefined],
    ['skill:extra', 'extra', 'undeclared', undefined],
    ['skill:mine', 'local', 'excluded', undefined],
  ]);
  assert.deepEqual(report.probeErrors, []);
});

test('a skill one agent cannot load becomes a per-agent link item', async () => {
  const m = skillsMachine();
  mkdirSync(join(m.paths.agentsSkills, 'tdd'), { recursive: true });   // Codex reads the store; Claude has no link
  const report = await m.run(inspectSkills(desiredWith([skill('tdd', 'o/r')])));
  assert.deepEqual(report.items.filter((i) => i.key.startsWith('skill-link:')).map((i) => [i.key, i.target, i.state, i.disposition]),
    [['skill-link:claude:tdd', 'claude', 'unlinked', 'apply']]);
});
```

Add one test for an unreadable store (chmod 000 on `agentsSkills`, root-skip as in Task 4): the probe error appears and the declared skill reads as `missing`.

- [ ] **Step 2: Run, verify failure.**

- [ ] **Step 3: Implement `inspectSkills` in `domain.ts`** using `readSkillLock`, `installedSkillNames` (wrapped in `Effect.result` so a failed list becomes the probe error), `readExposure(TARGETS)` and `skillExposure`. Imports `TARGETS` from `@nortuscc/profile-engine` and `SKILL_AGENTS` from `./installer.ts`. Append `export * from './domain.ts';` to `skills/index.ts`.

- [ ] **Step 4: Verify and commit**

```bash
git add packages/machine
git commit -m "feat: inspect skills as store and per-agent exposure items"
```

---

### Task 7: Skills domain `steps` and `run`

**Files:**
- Modify: `packages/machine/src/skills/domain.ts`
- Test: `packages/machine/checks/skills-domain.spec.ts`

**Interfaces:**
- Consumes: Tasks 3–6; `plan`, `execute`, `Backups`, `backupsForRun`.
- Produces:
  - `skillNamesOf(step: Step): string[]` (the `<name>` of each `skills/<name>` in `touches`)
  - `skillsDomain: Domain<Fs | MachinePaths | Processes | Backups>` with `name: 'skills'`, `inspect: inspectSkills`, `steps`, `run`.
  - Step shapes (all `domain: 'skills'`; names sorted with code-point order inside `touches`; steps in the order listed):

| kind | source items | step key | action | summary | touches | targets | interruptible |
| --- | --- | --- | --- | --- | --- | --- | --- |
| update | `gone` | `skills:remove` | `remove` | `removing N skill(s)` | `skills/<n>`… | — | true |
| update | `outdated` | `skills:update` | `update-skills` | `updating N skill(s)` | `skills/<n>`… | — | true |
| update | `available`, per source (sources in code-point order) | `skills:install:<source>` | `install-skills` | `installing N skill(s) from <source>` | `skills/<n>`… | `selection.targets` | true |
| update | any of the above present | `skills:expose` | `install-skills` | `re-exposing skills to <agent ids, comma-joined>` | `skills/<n>` of the **outdated** names | `selection.targets` | true |
| update | a remove or install step present | `skills:manifest` | `write-manifest` | `write skills-manifest.txt` | `['skills-manifest.txt']` | — | false |
| apply | `missing`+`apply`, plus `unlinked` whose `target` is in `selection.targets`, grouped per source | `skills:install:<source>` | `install-skills` | `installing N skill(s) from <source>` | `skills/<n>`… | `selection.targets` | true |

  - Skipped: `apply` with `'skills'` in `selection.declined` → every `apply`-disposition skill item `{ key, reason: 'skills declined' }` and no steps. `apply` → `missing`+`excluded` items `{ key, reason: 'optional, not chosen' }`. `update` → `blocked` items `{ key, reason: 'source unreachable' }`. `uninstall` and `capture` → no steps, no skips. Capture's manifest regeneration arrives with the capture cutover (#59), which owns the `--allow-shrink` choice.
  - `run(step, report)`:
    - `remove` / `update-skills`: `Backups.preserve(join(agentsSkills, n), join('skills', n))` for each name **before** running `removeCommand`/`updateCommand` via `runInstaller`.
    - `install-skills` with key `skills:install:<source>`: `runInstaller(addCommand({ source, skills: names, targets: step.targets ?? TARGETS }))`.
    - `skills:expose`: scope = `report.desired.skills` names ∪ `skillNamesOf(step)`, restricted to installed names. `readExposure(targets)`, then for every scoped name some target cannot load and whose lock entry has a source, group by source and run `addCommand` per source. Errored targets are not in `list`, so they are left out of the repair. Result ok when every add succeeded. Note: `re-exposed N skill(s) to <agent ids>` when N > 0, followed by any exposure errors joined with `; `; otherwise the errors or `''`.
    - `write-manifest`: `before = groupsOf(report.desired.skills)`. `pruned` = names of `gone` items in `report.items` that are no longer installed. `declared` = `before` with pruned names removed from optional groups (empty groups dropped). `groups = installedGroups(lock, installed, declared)`, then `manifestOutcome({ before, groups, prunedNames: pruned })`. On write: `fs.writeTextAtomic(join(paths.repo, MANIFEST_FILE), emitManifest(groups))`, note `written — <reason>`. Otherwise note `left alone — <reason>`. Always `ok: true`.
    - Any other action: `{ ok: false, note: 'skills cannot run <action>' }`.

- [ ] **Step 1: Failing tests**

Plan tests (pure, no I/O):

```ts
const item = (name: string, state: string, disposition: Observed['disposition'], group = 'o/r', extra: Partial<Observed> = {}): Observed =>
  ({ key: `skill:${name}`, domain: 'skills', label: name, group, state, disposition, ...extra });
const report = (items: Observed[], skills: ResolvedSkill[] = []): MachineReport =>
  ({ desired: desiredWith(skills), items, probeErrors: [] });

test('an update plan removes, refreshes, adopts, re-exposes, then writes the manifest', () => {
  const r = report([item('old', 'gone', 'apply'), item('stale', 'outdated', 'apply'), item('new', 'available', 'excluded', 'x/y'),
    item('far', 'unknown', 'blocked')]);
  const p = plan('update', r, { ...selectAll, targets: ['claude'] }, [skillsDomain]);
  assert.deepEqual(p.steps.map((s) => [s.key, s.action, s.touches, s.targets]), [
    ['skills:remove', 'remove', ['skills/old'], undefined],
    ['skills:update', 'update-skills', ['skills/stale'], undefined],
    ['skills:install:x/y', 'install-skills', ['skills/new'], ['claude']],
    ['skills:expose', 'install-skills', ['skills/stale'], ['claude']],
    ['skills:manifest', 'write-manifest', ['skills-manifest.txt'], undefined],
  ]);
  assert.deepEqual(p.skipped, [{ key: 'skill:far', reason: 'source unreachable' }]);
});

test('a refresh alone writes no manifest; nothing selected plans nothing', () => {
  const r = report([item('stale', 'outdated', 'apply'), item('new', 'available', 'excluded')]);
  assert.deepEqual(plan('update', r, { ...selectAll, only: ['skill:stale'] }, [skillsDomain]).steps.map((s) => s.key),
    ['skills:update', 'skills:expose']);
  assert.deepEqual(plan('update', r, { ...selectAll, only: [] }, [skillsDomain]).steps, []);
});

test('apply installs missing skills and re-exposes unlinked ones for the selected agents, per source', () => {
  const r = report([
    item('want', 'missing', 'apply'), item('maybe', 'missing', 'excluded'),
    { ...item('tdd', 'unlinked', 'apply'), key: 'skill-link:claude:tdd', target: 'claude' },
    { ...item('cx', 'unlinked', 'apply'), key: 'skill-link:codex:cx', target: 'codex' },
  ]);
  const p = plan('apply', r, { ...selectAll, targets: ['claude'] }, [skillsDomain]);
  assert.deepEqual(p.steps.map((s) => [s.key, s.touches, s.targets]), [['skills:install:o/r', ['skills/tdd', 'skills/want'], ['claude']]]);
  assert.deepEqual(p.skipped, [{ key: 'skill:maybe', reason: 'optional, not chosen' }]);
  assert.deepEqual(plan('apply', r, { ...selectAll, declined: ['skills'] }, [skillsDomain]).steps, []);
});

test('the same report and selection always plan the same steps', () => {
  const r = report([item('b', 'missing', 'apply', 'z/z'), item('a', 'missing', 'apply', 'a/a')]);
  assert.ok(samePlan(plan('apply', r, selectAll, [skillsDomain]), plan('apply', r, selectAll, [skillsDomain])));
});
```

Run tests (through `execute`, real `nodeFs`, `backupsForRun()`, and a fake `Processes` that records argv and simulates the installer on the temp store and lock):

```ts
// fakeInstaller(m, behaviour): Layer<Processes> — records every Command; for npx `remove` deletes the
// store folders and lock entries, for `update` sets each named lock entry's skillFolderHash to 'new',
// for `add` creates store folders, lock entries { source } and (when claude-code is an agent) a
// ~/.claude/skills/<n> directory. `behaviour.fail` names a verb that exits 1 instead.
```

Write `fakeInstaller` in full in the spec file following that description. Then these tests:

1. **Backups first:** update plan for `stale` (store folder holding `SKILL.md`). After `execute`, the run's backup folder contains `skills/stale/SKILL.md`. The recorded command is `npx -y skills update stale --global --yes`. The plan is `skills:update` then `skills:expose`, and the events end with `done { ok: 2, failed: 0, backups: <the run folder> }`.
2. **Manifest goes to `paths.repo` only:** `paths.repo` is a temp dir holding `[o/r]\nold\nstale\n`; prune `old` (gone). After execute, `join(paths.repo, 'skills-manifest.txt')` equals `emitManifest([{ source: 'o/r', skills: ['stale'], exact: false, optional: false }])`. The `skills:manifest` finished note starts with `written`.
3. **Guard:** manifest lists `a`..`f` that are not installed; prune `old`. The file is unchanged and the note matches `/^left alone — would drop 6 entr\(ies\)/`.
4. **`--target claude`:** an install step planned with `targets: ['claude']` records `--agent claude-code` only.
5. **Exposure repair:** declared `tdd` installed in the store and lock (`source: 'o/r'`) with no Claude link. Running the `skills:expose` step with targets `['claude']` records one `add o/r --skill tdd --agent claude-code`. The note is `re-exposed 1 skill(s) to claude-code`.
6. **Unreadable agent dir is not a reason to reinstall:** same as 5 with `~/.claude/skills` chmod 000 (root-skip). No `add` is recorded, the step is ok, and the note mentions `could not read the skill directory for claude-code`.
7. **A failing installer fails its step only:** `fail: 'update'`. The `skills:update` step finishes `failed` with note `npx exited with 1`, and later steps still run.

- [ ] **Step 2: Run, verify failure.**

- [ ] **Step 3: Implement** `steps`, `run`, `skillNamesOf` and `skillsDomain` in `domain.ts` to the tables above. Keep the order and texts exact. They are what `samePlan` and the CLI compare.

- [ ] **Step 4: Verify and commit**

Run: `npm test -w packages/machine && npm run typecheck -w packages/machine`. Expected: PASS.

```bash
git add packages/machine
git commit -m "feat: plan and run skill installs, updates, prunes and manifest writes in the skills domain"
```

---

### Task 8: Undeclared-items probe

**Files:**
- Create: `packages/machine/src/undeclared/probe.ts`
- Modify: `packages/machine/src/index.ts` (`export * from './undeclared/probe.ts';`)
- Test: `packages/machine/checks/undeclared.spec.ts` (port `test/inventory.test.mjs` and `test/inventory-probe.test.mjs`)

**Boundary with #56:** the probe reads only the Claude-side directories and files no domain owns (`~/.claude/agents`, `~/.claude/skills`, `settings.json` hooks). Installed plugins and marketplaces, and the command each declared hook registers, are **inputs**. The integrations domain (#56) observes them, and the `status` cutover (#59) passes them in. That way the two threads never write two readers for the same state.

**Interfaces:**
- Consumes: `DesiredConfig` (`integrations`, `allow`), `Fs`, `MachinePaths`.
- Produces:
  - `BUILTIN_MARKETPLACES: ReadonlySet<string>`, `marketplaceOf(plugin: string): string | null`
  - `type Found = { key: string; label: string; note: string }`
  - `type InstalledIntegrations = { readonly target: Target; readonly plugins: ReadonlyArray<string>; readonly marketplaces: ReadonlyArray<string> }`
  - `type ProbeInput = { readonly targets: ReadonlyArray<Target>; readonly installed: ReadonlyArray<InstalledIntegrations>; readonly hookCommands: ReadonlyArray<string> }`
  - `declaredIds(declarations: ReadonlyArray<Integration>, hookCommands: ReadonlyArray<string>): { plugins; marketplaces; hooks: Set<string> }`
  - `manifestDefects(declarations: ReadonlyArray<Integration>): Found[]`
  - `observedAgents`, `observedSkillLinks`, `observedHooks`: `Effect<{ items: Found[]; errors: string[] }, never, Fs | MachinePaths>`
  - `probeUndeclared(desired: DesiredConfig, input: ProbeInput): Effect<{ items: Observed[]; probeErrors: string[] }, never, Fs | MachinePaths>`
- Item shape: key `undeclared:<category>:<found.key>`, `group` = category, `label`/`note` from `Found`, state `undeclared`, disposition `undeclared`. `domain`: `skills` for skills, `config` for agents, `integrations` for plugins, marketplaces, hooks and manifest defects. `target`: `claude` for agents, skills and hooks; the observation's target for plugins and marketplaces; the declaration's target for defects. Manifest defects use category `manifest`, state `defect`, disposition `undeclared`; they describe the repo, so status treats them like the other undeclared rows. Declarations are `desired.integrations.map((i) => i.declaration)` filtered to `input.targets`. Claude-side categories are walked only when `targets` includes `claude`. Allowed keys come from `desired.allow[category]`. Errors become probe errors as `<category>: <message>`.

- [ ] **Step 1: Failing tests.** Port every case of `test/inventory.test.mjs` (pure) and `test/inventory-probe.test.mjs` (readers), adapting injection from `claudeDir`/`agentsSkills` functions to a temp `MachinePaths`. Port the readers verbatim from `src/inventory-probe.mjs`. Keep these cases:
  - an agent symlink's note is `-> <target>`
  - a skill link to the store via a relative **or** absolute path is not reported
  - a dangling link is `broken link`
  - a store that exists but cannot be resolved is an error, not "every link undeclared"
  - unparseable `settings.json` is the error `could not parse <path>`
  - hooks key on command and label by event

Add one `probeUndeclared` end-to-end case: a plugin `p@m` observed on codex while `m` is undeclared, plus an allow-listed agent. Assert the exact `Observed` items and the targets.

- [ ] **Step 2: Run, verify failure.**

- [ ] **Step 3: Implement** with `Fs.list` (skip dot entries), `Fs.stat` (kind `symlink`), `Fs.readLink`, `Fs.realPath` and `Fs.readText`. Each reader catches its own `FsFailed` into `errors`.

- [ ] **Step 4: Verify and commit**

```bash
git add packages/machine
git commit -m "feat: port the undeclared-items probe to the machine package"
```

---

### Task 9: `src/commands/update.ts`

**Files:**
- Create: `src/commands/update.ts`, `test/update.test.ts`

**Interfaces:**
- Consumes: `inspectUpdates`, `skillsDomain`, `readSkillLock`, `SKILL_AGENTS`, `short`, `plan`, `execute`, `selectAll`, `backupsForRun`, `nodeFs`, `nodeProcesses`, `machinePaths`, `pathsFromEnvironment` (`@nortuscc/machine`); `loadProfile`, `nodeFiles` (`@nortuscc/profile-engine`); `formatRow`, `section`, `labelWidth` (`../report.mjs`); `select` (`../select.mjs`); `parseTarget`, `selectedTargets` (`../targets.mjs`).
- Produces:
  - `parseFlags(args: string[]): { check; yes; prune; add: string[]; error: string | null }` (port verbatim)
  - `exitCode(input: { items: ReadonlyArray<Observed>; failed: boolean; prunedNames?: ReadonlyArray<string> }): 0 | 1`: 1 when failed, when any `gone` item is not in `prunedNames`, or when any `unknown` item exists
  - `reportLines(items: ReadonlyArray<Observed>): string[]` (port, reading buckets from item states; detail rows `formatRow(name, 'outdated', '<note>  <group>', width)`)
  - `choices(items, seeded: ReadonlySet<string>): { key; group: 'update' | 'remove' | 'add'; label; note; checked }[]`: keys are item keys; `outdated` rows checked by default
  - `seedKeys(items, flags: { add: string[]; prune: boolean }): Set<string>`
  - `type UpdateDeps = { layer: Layer.Layer<Fs | MachinePaths | Processes>; select: typeof select; isTTY: boolean; signal?: AbortSignal }`
  - `runUpdate(args: string[], deps: UpdateDeps): Promise<number>`
  - `run(args: string[]): Promise<number>`: builds the real layer (`pathsFromEnvironment({ env: process.env, home: homedir(), platform: process.platform, fallbackRepo: <repo root of this file>, warn: console.error })`, `nodeFs`, `nodeProcesses()`), wires SIGINT to an `AbortController` (remove the listener on exit), and calls `runUpdate`.

**Behaviour of `runUpdate`, in order** (legacy texts unless marked new):
1. `parseTarget`, then `parseFlags`. On error print `nortuscc: <error>` (+ usage line for flag errors) to stderr and return 2, before any I/O.
2. `loadProfile(paths.repo)` with `nodeFiles` (no `requireValid`: an `integrations.json` issue must not block `update`). Then `inspectUpdates(desired)`. Print probe errors to stderr. Print `'\n' + section('update', reportLines(items))`.
3. Unmatched `--add` handling, `--check` exit, the empty-rows exit, `--yes` defaults, picker, non-TTY refusal (exit 2) and "nothing selected": port verbatim from `src/commands/update.mjs`, reading `available`, `unknown` and `gone` from item states.
4. `selection = { ...selectAll, targets: selectedTargets(target), only: keys }`. `p = plan('update', report, selection, [skillsDomain])`. If `p.steps` is empty, print `nothing selected` and return the exit code.
5. `before = readSkillLock`. Run `execute(p, report, [skillsDomain], { signal })` with `backupsForRun()` provided on top of `deps.layer`, consuming the stream with `Stream.runForEach`:
   - `started` for `skills:remove`, `skills:update` and `skills:install:*` → print `\n<summary>`.
   - `finished`: on a failed outcome record the key and print `\n<key>: <note>` when the note is non-empty. For `skills:expose` with a non-empty note print `\n<note>`. For `skills:manifest` print `\nskills-manifest.txt <note>\n`, plus `Run: nortuscc push -m "..."   to share it\n` when the note starts with `written`.
   - `done` / `cancelled`: keep `backups`. On `cancelled` (new) print `\ncancelled — not run: <remaining keys joined>` and finish with exit 1.
   - A `LockHeld` failure (new): print `nortuscc: <message>` to stderr and return 1.
6. Print `\nbacked up -> <dir>` when the run reported a backup folder.
7. `after = readSkillLock`. Closing `section('done', …)` rows, legacy formats:
   - updated: `formatRow(name, 'updated', '<short(from)> -> <short(to)>', width)` for updated names whose hash verifiably moved
   - unchanged: `formatRow('skills', 'unchanged', 'the updater reported no change')` when an update ran but nothing moved
   - removed or failed: `removed` / `failed` + `remove failed — see output above`
   - added or failed per install step: `added <source>` / `failed <source> — install failed, see output above`
8. On any failure print `\nSomething failed above. The backup is listed above.\n` when a backup exists, else `\nSomething failed above. No backup was made — nothing existed to preserve.\n`.
9. Return `exitCode({ items, failed: anyFailed || addFailed || cancelled, prunedNames: removeSucceeded ? removed : [] })`.

- [ ] **Step 1: Failing tests (`test/update.test.ts`)**

Port the tests of `test/update.test.mjs` that still describe behaviour. Group them:

- **Pure** (`parseFlags`, `exitCode`, `reportLines`, `choices`, `seedKeys`): port every case, with the plan fixtures rewritten as items via a helper `items({ current, outdated, gone, unknown, local, available })` that builds `Observed[]` exactly as `updateItems` would.
- **Orchestration** through `runUpdate`, with a temp machine (`NORTUSCC_*` not used; build `MachinePaths` directly), a temp repo holding `skills-manifest.txt`, real `git` sources (local repos, as in Task 5), and a `Processes` layer that delegates `git` to `nodeProcesses()` and fakes `npx` like Task 7's `fakeInstaller`. Capture stdout by swapping `process.stdout.write` for the call, as the legacy file does. Port these legacy cases by name:
  - `--check reports outdated skills and updates nothing`
  - `--check never prompts`
  - `an all-current machine exits 0 and updates nothing`
  - `a confirmed run backs up and updates only the outdated skills`
  - `--yes skips the prompt entirely`
  - `no TTY and no --yes refuses with exit 2 rather than hanging`
  - `an unreachable source exits 1 and updates nothing`
  - `a failing updater exits 1`
  - `a skill whose folder vanished upstream is never sent to the updater`
  - `the closing report names the hash the lock actually moved to`
  - `an unmoved lock (no writer touched it) still reports unchanged`
  - `two sources: an unreachable one only marks its own skills unknown`
  - `gone with nothing outdated prints the prune pointer and --check exits 1`
  - `the gone footer names the gone skills, not just a bare pronoun`
  - `a long skill name keeps the outdated detail rows aligned`
  - `an exact source is never scanned, so nothing from it is offered`
  - `the picker drives what gets executed`
  - `--add and --prune pre-tick their rows in the picker, not just under --yes`
  - `a cancelled picker changes nothing and exits 0`
  - `--yes --add adopts exactly the named skills`
  - `a scripted --add naming an unmatched skill reports it and exits non-zero`
  - `an unmatched --add name blames an unreachable source when one exists, not just a typo`
  - `removals are backed up before anything is removed`
  - `a pruned gone skill no longer forces exit 1`
  - `the manifest is written after adopting`
  - `the manifest is left alone when nothing was adopted or pruned`
  - `pruning an optional skill removes its declaration while preserving unselected optional skills`
  - `a shrink larger than what was pruned leaves a populated manifest alone`
  - `a failing remover reports the skill as failed, not removed`
  - `a failing installer reports the skill as failed, not added`
- **Not ported** (behaviour no longer exists; say so in the PR): `a skill whose backup returns null is named as unprotected` (an installed skill is by definition a folder that exists, so its copy always exists), `backups are taken before the updater runs` (now pinned in Task 7 test 1), and `an installer that returns no result for a requested source` (each source is its own step and always has a result).
- **New:**

```ts
test('cancelling mid-update stops before the manifest and exits non-zero', async () => {
  // npx `add` blocks until the AbortController fires (fake Processes: Effect.never for add, so the
  // interruptible step is interrupted). Run `--yes --add wizard`, abort after the `installing` line.
  // Expect: exit 1, stdout matches /cancelled — not run: skills:expose, skills:manifest/, manifest unchanged.
});

test('--target claude adopts for Claude only', async () => {
  // `--target claude --yes --add wizard` records an add whose --agent list is exactly ['claude-code'].
});
```

Write both in full in the spec's style. For cancellation, the fake `Processes.run` for `add` returns `Effect.never`, and the test aborts the controller once stdout contains `installing`. Poll stdout with a short `setInterval`, then `clearInterval`.

- [ ] **Step 2: Run, verify failure**: `node --test test/update.test.ts` (module missing).

- [ ] **Step 3: Implement `src/commands/update.ts`** to the behaviour list. Keep the legacy comments that explain a rule: the `--add` parsing, the shrink guard pointer, the prune footer, `--yes` defaults, the non-TTY refusal.

- [ ] **Step 4: Verify**

Run: `node --test test/update.test.ts && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/update.ts test/update.test.ts
git commit -m "feat: port nortuscc update to the machine package's skills domain"
```

---

### Task 10: Cut `update` over and retire its legacy modules

**Files:**
- Modify: `bin/commands.mjs` (`export const PORTED = ['update'];`)
- Delete: `src/commands/update.mjs`, `src/skill-actions.mjs`, `src/skill-updates.mjs`, `src/git-trees.mjs`, `test/update.test.mjs`, `test/skill-actions.test.mjs`, `test/skill-updates.test.mjs`, `test/git-trees.test.mjs`
- Modify: `src/report.mjs` (its comment names `skill-actions.mjs`; point it at `src/commands/update.ts`), `packages/machine/README.md` (skills domain and probe bullets), `CLAUDE.md` only if a table row became wrong
- Test: `test/update-blackbox.test.ts` (unchanged from Task 1), `test/main.test.ts`, `test/cli.test.mjs`, `test/launcher.test.mjs`

- [ ] **Step 1: Check nothing else imports the files being deleted**

Run: `grep -rn "skill-actions\|skill-updates\|git-trees\|commands/update.mjs" src bin test packages apps --include=*.mjs --include=*.ts --include=*.js | grep -v node_modules`
Expected: only the files being deleted, and the `report.mjs` comment.

- [ ] **Step 2: Cut over and delete.** Set `PORTED`, `git rm` the eight files, and fix the comment.

Add to `test/main.test.ts`:

```ts
test('a ported command runs its TypeScript module', () => {
  const result = run('update', '--check', '--yes');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--check is mutually exclusive/);
});
```

and assert `PORTED` includes `'update'` wherever `test/launcher.test.mjs` pins it (adjust that test if it asserts an empty list).

- [ ] **Step 3: Run the parity suite and the CLI suites**

Run: `node --test test/update-blackbox.test.ts test/main.test.ts test/cli.test.mjs test/launcher.test.mjs`
Expected: PASS. The black-box file is byte-identical to Task 1's.

- [ ] **Step 4: Full verification (once)**

```bash
npm test; git status --short
npm run test:packages
npm run typecheck
```

Expected: everything passes except the known pre-existing failures (`apps/desktop/checks/backend.spec.ts` teardown abort on Node 24.19, intermittent `test/fresh-machine.test.mjs`). If `git status` shows `skills-manifest.txt` modified, run `git checkout -- skills-manifest.txt`, then identify which legacy test wrote it (not `update`, which now writes only under `MachinePaths.repo`) and record it in the PR.

- [ ] **Step 5: Commit**

```bash
git add -A bin src test packages/machine/README.md
git status --short   # confirm skills-manifest.txt is not staged
git commit -m "feat: cut nortuscc update over to TypeScript and retire its legacy modules"
```

---

## Self-review notes

- Spec coverage. Skills domain: Tasks 3–7. Undeclared probe: Task 8. `write-manifest` with an explicit repo: Task 7 run, test 2. `update` cutover: Tasks 9–10. Black-box before and after: Tasks 1 and 10. Contract additions are called out: Task 2.
- Deliberately out of scope: capture's manifest regeneration and `--allow-shrink` (#59), status rendering of skill and probe items (#59), and reading plugin and marketplace state (#56).
- Behaviour changes the PR must name:
  - an installed skill missing from the manifest is disposition `undeclared`, so `status --strict` will flag it once #59 renders it
  - the backup line prints after the run rather than before
  - per-step installer runs replace one batched `add` call across sources (adds were already per source; removes and updates stay batched)
  - a `cancelled` outcome exists
  - npx on Windows depends on the foundation's no-shell `Processes`
