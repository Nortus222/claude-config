# Interactive `nortuscc update` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `nortuscc update` from a report-and-refresh command into one interactive pass that adopts new upstream skills, refreshes outdated ones, and prunes ones deleted upstream.

**Architecture:** Two seams carry the work. `src/select.mjs` is a generic grouped multi-select that knows nothing about skills — a pure `reduce`/`render` pair plus a thin raw-mode driver, so selection logic is tested with no terminal. `src/skill-actions.mjs` is pure logic turning a plan plus a set of selected keys into `{update, remove, add}`, so `src/commands/update.mjs` never branches on a skill's state. The manifest is rebuilt from what is on disk rather than from the skill lock, because the lock outlives the folder.

**Tech Stack:** Node 18+, plain ESM `.mjs`, `node:test`, `node:assert/strict`, `node:readline` raw mode, ANSI escapes, `git` and `npx` as subprocesses.

Spec: `docs/superpowers/specs/2026-08-05-nortuscc-update-interactive-design.md`
Builds on: `docs/superpowers/specs/2026-08-05-nortuscc-update-design.md` (already merged into this branch)

## Global Constraints

- Node 18+, plain ESM `.mjs`, **zero dependencies** including test tooling.
- `node:`-prefixed builtin imports throughout.
- Tests use `node:test` and `node:assert/strict` only.
- Test-first: write the failing test, watch it fail, then write the module.
- Run the suite with bare `npm test`. Never `node --test test/` — this machine is Node v25.9.0, where passing a path reports `pass 0 / fail 1`. `package.json` already carries `--test-timeout=30000`; keep it.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`. Commit after every task. Append to every commit message:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **No test may spawn `npx skills`, run `git clone` against a remote, hit the network, write to the real `~/.agents`, or enter raw mode.**
- Nothing destructive runs without a backup to `~/.claude/backups/` first. `--prune` deletes skills outright and is bound by this most of all.
- Never stage `.superpowers/` (git-ignored scratch).
- Work in the worktree `.claude/worktrees/nortuscc-update` on branch `nortuscc-update`. PRs target `main`.

## Existing interfaces this plan builds on

Already committed on this branch; do not reimplement.

- `src/skill-updates.mjs`: `skillFolder(skillPath)`, `updatableSkills(lock, installedNames)`, `sourcesOf(entries)`, `planUpdates({lock, installedNames, remoteTrees})` → `{current, outdated, gone, unknown, local}`.
- `src/git-trees.mjs`: `buildCloneArgs`, `buildRevParseArgs`, `resolveTrees(sourceUrl, paths, {run})` → `Promise<Map<path, sha|null> | null>`.
- `src/prompt.mjs`: `interpret(answer)`, `confirm(question, {input, output, isTTY})` → `Promise<boolean|null>`.
- `src/backup.mjs`: `backupDir()`, `backupPath(relative)`, `backupOnce(abs, rel)` (moves), `preserveCopy(abs, rel)` (copies).
- `src/skills-cli.mjs`: `buildCommand({source, skills})`, `installGroups(groups, {dryRun})`, `buildUpdateCommand(names)`, `runUpdate(names, {dryRun})`.
- `src/skills.mjs`: `parseManifest(text)`, `emitManifest(groups)`, `groupsFromLock(lock)`, `reconcile(...)`, `installArgs(missing)`, `readSkillsManifest()`, `readSkillLock()`, `installedSkillNames()`, `manifestPath()`.
- `src/report.mjs`: `formatRow(label, state, note, width)`, `section(title, lines)`, `labelWidth(labels)`.
- `src/commands/update.mjs`: `exitCode({plan, updateFailed})`, `reportLines(plan)`, `run(args, deps)`.

## File Structure

| File | Responsibility | New? |
| --- | --- | --- |
| `src/select.mjs` | Generic grouped multi-select: `initialState`, `reduce`, `render`, `select`. No skill vocabulary | new |
| `src/skill-actions.mjs` | Pure. `choices(plan)`, `actionsFrom(plan, keys)`, `seedKeys(plan, {add, prune})` | new |
| `src/git-trees.mjs` | `inspectSource` replaces `resolveTrees`; adds `buildLsTreeArgs` | modify |
| `src/skill-updates.mjs` | Adds `upstreamSkills(skillPaths)`, `availableSkills({upstreamBySource, installedNames})` | modify |
| `src/skills.mjs` | Adds `installedGroups(lock, installedNames)` | modify |
| `src/skills-cli.mjs` | Adds `buildRemoveCommand(names)`, `runRemove(names, {dryRun})` | modify |
| `src/commands/update.mjs` | Orchestration: gather, present, execute, write manifest, report | modify |
| `README.md`, spec, `bin/nortuscc.mjs` | Docs and usage | modify |

Tasks 1–6 are independent and each ships a tested unit. Task 7 composes the picker into the command. Task 8 adds the executors and the manifest write. Task 9 documents.

---

### Task 1: Selection state machine (`src/select.mjs`, pure half)

**Files:**
- Create: `src/select.mjs`
- Test: `test/select.test.mjs`

**Interfaces:**
- Produces:
  - `initialState(items) -> {items, cursor}` where `items` is `Array<{key, group, label, note, checked}>`. `initialState` inserts nothing; the caller supplies rows already grouped in display order. `cursor` is the index of the first item, or `-1` when `items` is empty.
  - `reduce(state, key) -> {state, done}` — `key` is a normalised key name string. `done` is `null` while the picker runs, `'confirm'` on enter, `'cancel'` on escape/ctrl-c/q.
  - `selectedKeys(state) -> string[]` — keys of checked items, in display order.
  - `groupOf(state) -> string` — the group of the item under the cursor.

Group headers are **not** items. `render` derives them from each item's `group` field, so the cursor can never land on one and no "skip the header" logic is needed anywhere.

- [ ] **Step 1: Write the failing test**

Create `test/select.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, selectedKeys, groupOf } from '../src/select.mjs';

const ITEMS = [
  { key: 'u:a', group: 'update', label: 'a', note: '', checked: true },
  { key: 'u:b', group: 'update', label: 'b', note: '', checked: true },
  { key: 'r:c', group: 'remove', label: 'c', note: '', checked: false },
  { key: 'a:d', group: 'add', label: 'd', note: '', checked: false },
];

const press = (state, ...keys) => keys.reduce((s, k) => reduce(s, k).state, state);

test('initialState starts on the first item', () => {
  assert.equal(initialState(ITEMS).cursor, 0);
});

test('initialState on no items has no cursor', () => {
  assert.equal(initialState([]).cursor, -1);
});

test('initialState does not mutate the caller\'s items', () => {
  const items = [{ key: 'x', group: 'g', label: 'x', note: '', checked: false }];
  const state = initialState(items);
  reduce(state, 'space');
  assert.equal(items[0].checked, false, 'reduce must not write through to the input');
});

test('down moves one item and up moves back', () => {
  const s = press(initialState(ITEMS), 'down');
  assert.equal(s.cursor, 1);
  assert.equal(press(s, 'up').cursor, 0);
});

test('j and k move like down and up', () => {
  assert.equal(press(initialState(ITEMS), 'j').cursor, 1);
  assert.equal(press(initialState(ITEMS), 'j', 'k').cursor, 0);
});

test('down wraps from the last item to the first', () => {
  assert.equal(press(initialState(ITEMS), 'down', 'down', 'down', 'down').cursor, 0);
});

test('up wraps from the first item to the last', () => {
  assert.equal(press(initialState(ITEMS), 'up').cursor, ITEMS.length - 1);
});

test('space toggles only the item under the cursor', () => {
  const s = press(initialState(ITEMS), 'space');
  assert.equal(s.items[0].checked, false, 'a checked item toggles off');
  assert.equal(s.items[1].checked, true, 'its neighbour is untouched');
});

test('space checks an unchecked item', () => {
  const s = press(initialState(ITEMS), 'down', 'down', 'space');
  assert.equal(s.items[2].checked, true);
});

test('a checks every item in the current group only', () => {
  // Cursor parked in the middle group, so an implementation that ignores the
  // cursor and checks everything cannot pass.
  const s = press(initialState(ITEMS), 'down', 'down', 'a');
  assert.equal(s.items[2].checked, true, 'the current group is checked');
  assert.equal(s.items[3].checked, false, 'a later group must be untouched');
  assert.equal(s.items[0].checked, true, 'an earlier group keeps its own state');
});

test('n clears every item in the current group only', () => {
  const s = press(initialState(ITEMS), 'n');
  assert.equal(s.items[0].checked, false);
  assert.equal(s.items[1].checked, false);
  assert.equal(s.items[2].checked, false, 'remove was already clear');
  const seeded = press(initialState(ITEMS), 'down', 'down', 'space', 'up', 'up', 'n');
  assert.equal(seeded.items[2].checked, true, 'clearing update must not clear remove');
});

test('A checks every item in every group', () => {
  const s = press(initialState(ITEMS), 'A');
  assert.ok(s.items.every((i) => i.checked));
});

test('N clears every item in every group', () => {
  const s = press(initialState(ITEMS), 'N');
  assert.ok(s.items.every((i) => !i.checked));
});

test('enter reports confirm', () => {
  assert.equal(reduce(initialState(ITEMS), 'return').done, 'confirm');
});

test('escape, ctrl-c and q report cancel', () => {
  for (const key of ['escape', 'ctrl-c', 'q']) {
    assert.equal(reduce(initialState(ITEMS), key).done, 'cancel', `${key} should cancel`);
  }
});

test('an unrecognised key changes nothing and does not finish', () => {
  const before = initialState(ITEMS);
  const { state, done } = reduce(before, 'z');
  assert.equal(done, null);
  assert.deepEqual(selectedKeys(state), selectedKeys(before));
  assert.equal(state.cursor, before.cursor);
});

test('selectedKeys returns checked keys in display order', () => {
  assert.deepEqual(selectedKeys(initialState(ITEMS)), ['u:a', 'u:b']);
});

test('selectedKeys on an all-clear state is empty', () => {
  assert.deepEqual(selectedKeys(press(initialState(ITEMS), 'N')), []);
});

test('groupOf names the group under the cursor', () => {
  assert.equal(groupOf(initialState(ITEMS)), 'update');
  assert.equal(groupOf(press(initialState(ITEMS), 'down', 'down')), 'remove');
});

test('keys on an empty list do not throw', () => {
  const empty = initialState([]);
  for (const key of ['down', 'up', 'space', 'a', 'A', 'n', 'N']) {
    assert.doesNotThrow(() => reduce(empty, key), `${key} on an empty list`);
  }
  assert.equal(reduce(empty, 'return').done, 'confirm');
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../src/select.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `src/select.mjs`:

```js
// A grouped multi-select that knows nothing about what it is selecting. The
// state machine and the renderer are pure and hold no terminal state, so every
// key behaviour is tested without raw mode; only `select` below touches a TTY.

// Group headers are derived at render time from each item's `group`, never
// stored as items. That way the cursor indexes real rows only and no movement
// code has to know headers exist.
export function initialState(items) {
  return {
    // Copied, because reduce returns new items and a caller that reused its
    // input array would see toggles it never asked for.
    items: items.map((i) => ({ ...i })),
    cursor: items.length ? 0 : -1,
  };
}

export function selectedKeys(state) {
  return state.items.filter((i) => i.checked).map((i) => i.key);
}

export function groupOf(state) {
  return state.cursor < 0 ? '' : state.items[state.cursor].group;
}

function move(state, delta) {
  if (state.cursor < 0) return state;
  const n = state.items.length;
  // Wrapping in both directions: the lists are short and a cursor that sticks
  // at an end makes "jump to the other end" a long hold.
  return { ...state, cursor: (state.cursor + delta + n) % n };
}

function setAll(state, checked, group) {
  return {
    ...state,
    items: state.items.map((i) => (group === null || i.group === group ? { ...i, checked } : i)),
  };
}

function toggle(state) {
  if (state.cursor < 0) return state;
  return {
    ...state,
    items: state.items.map((i, n) => (n === state.cursor ? { ...i, checked: !i.checked } : i)),
  };
}

// Returns {state, done}. `done` stays null while the picker runs; the driver
// stops on 'confirm' or 'cancel'. Returning rather than throwing keeps the
// machine pure and lets a test drive a whole session synchronously.
export function reduce(state, key) {
  switch (key) {
    case 'up':
    case 'k':
      return { state: move(state, -1), done: null };
    case 'down':
    case 'j':
      return { state: move(state, 1), done: null };
    case 'space':
      return { state: toggle(state), done: null };
    case 'a':
      return { state: setAll(state, true, groupOf(state)), done: null };
    case 'n':
      return { state: setAll(state, false, groupOf(state)), done: null };
    case 'A':
      return { state: setAll(state, true, null), done: null };
    case 'N':
      return { state: setAll(state, false, null), done: null };
    case 'return':
      return { state, done: 'confirm' };
    case 'escape':
    case 'ctrl-c':
    case 'q':
      return { state, done: 'cancel' };
    default:
      return { state, done: null };
  }
}
```

Note on `a`/`n` with an empty list: `groupOf` returns `''`, no item has that group, so `setAll` matches nothing and the state is unchanged. That is why the empty-list test passes without a special case.

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/select.mjs test/select.test.mjs
git commit -m "feat: add a grouped multi-select state machine"
```

---

### Task 2: Selection rendering and the raw-mode driver (`src/select.mjs`)

**Files:**
- Modify: `src/select.mjs` (append)
- Test: `test/select-render.test.mjs`

**Interfaces:**
- Consumes: `initialState`, `reduce`, `selectedKeys` from Task 1.
- Produces:
  - `render(state, {title}) -> string[]` — display lines, no trailing newline, no ANSI cursor movement.
  - `keyName(str, keyObj) -> string|null` — maps a `node:readline` keypress to the names `reduce` understands. `null` for keys with no meaning.
  - `select(items, {title, input, output, isTTY}) -> Promise<string[]|null>` — `null` means cancelled **or** no TTY. The caller distinguishes those by checking `isTTY` itself.

- [ ] **Step 1: Write the failing test**

Create `test/select-render.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { initialState, render, keyName, select } from '../src/select.mjs';

const ITEMS = [
  { key: 'u:a', group: 'update', label: 'ask-matt', note: 'c7d5778 -> c9c83b1', checked: true },
  { key: 'u:b', group: 'update', label: 'setup-matt-pocock-skills', note: '634cf9b -> abf20c0', checked: true },
  { key: 'r:c', group: 'remove', label: 'to-issues', note: 'gone upstream', checked: false },
];

const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });

test('render marks checked and unchecked items differently', () => {
  const out = render(initialState(ITEMS), { title: 't' }).join('\n');
  assert.match(out, /◉ ask-matt/);
  assert.match(out, /◯ to-issues/);
});

test('render puts the cursor on the current item only', () => {
  const lines = render(initialState(ITEMS), { title: 't' });
  const pointed = lines.filter((l) => l.includes('❯'));
  assert.equal(pointed.length, 1);
  assert.match(pointed[0], /ask-matt/);
});

test('render emits one header per group, in first-appearance order', () => {
  const lines = render(initialState(ITEMS), { title: 't' });
  const headers = lines.filter((l) => /^\s*(update|remove) \(\d+\)/.test(l));
  assert.deepEqual(headers.map((h) => h.trim().split(' ')[0]), ['update', 'remove']);
});

test('render counts the items in each group header', () => {
  const out = render(initialState(ITEMS), { title: 't' }).join('\n');
  assert.match(out, /update \(2\)/);
  assert.match(out, /remove \(1\)/);
});

test('render aligns notes past the longest label', () => {
  const lines = render(initialState(ITEMS), { title: 't' }).filter((l) => / -> |gone/.test(l));
  const columns = lines.map((l) => l.indexOf(l.match(/(c7d5778|634cf9b|gone)/)[0]));
  assert.equal(new Set(columns).size, 1, 'every note must start at the same column');
});

test('render includes the key legend', () => {
  const out = render(initialState(ITEMS), { title: 't' }).join('\n');
  assert.match(out, /space/);
  assert.match(out, /enter/);
  assert.match(out, /esc/);
});

test('render shows the title', () => {
  assert.match(render(initialState(ITEMS), { title: 'pick some' }).join('\n'), /pick some/);
});

test('keyName maps arrows, space, enter and escape', () => {
  assert.equal(keyName('', { name: 'up' }), 'up');
  assert.equal(keyName('', { name: 'down' }), 'down');
  assert.equal(keyName(' ', { name: 'space' }), 'space');
  assert.equal(keyName('', { name: 'return' }), 'return');
  assert.equal(keyName('', { name: 'escape' }), 'escape');
});

test('keyName maps ctrl-c regardless of the letter case reported', () => {
  assert.equal(keyName('', { name: 'c', ctrl: true }), 'ctrl-c');
});

test('keyName preserves case so a and A stay distinct', () => {
  assert.equal(keyName('a', { name: 'a', shift: false }), 'a');
  assert.equal(keyName('A', { name: 'a', shift: true }), 'A');
});

test('keyName returns null for a key with no meaning', () => {
  assert.equal(keyName('', { name: 'f5' }), null);
});

test('select returns null without a TTY rather than waiting forever', async () => {
  const answer = await select(ITEMS, {
    title: 't', input: Readable.from([]), output: sink(), isTTY: false,
  });
  assert.equal(answer, null);
});

test('select on an empty item list returns an empty selection without a TTY', async () => {
  const answer = await select([], {
    title: 't', input: Readable.from([]), output: sink(), isTTY: false,
  });
  assert.deepEqual(answer, [], 'nothing to choose is not the same as refusing to ask');
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `render is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/select.mjs`:

```js
import { emitKeypressEvents } from 'node:readline';

const CHECKED = '◉';
const UNCHECKED = '◯';
const POINTER = '❯';
const LEGEND = [
  '  ↑↓ move · space toggle · a all in group · A all · n none in group · N none',
  '  enter confirm · esc cancel',
];

// Pure: returns the lines to draw, with no cursor movement or clearing. The
// driver owns everything about where on the screen these land, which is what
// lets the whole layout be asserted in a test with no terminal.
export function render(state, { title }) {
  const lines = [`  ${title}`, ''];
  // Notes line up past the longest label across every group, so the columns do
  // not step as the eye moves down the list.
  const width = Math.max(0, ...state.items.map((i) => i.label.length));

  let group = null;
  state.items.forEach((item, n) => {
    if (item.group !== group) {
      group = item.group;
      const count = state.items.filter((i) => i.group === group).length;
      if (n > 0) lines.push('');
      lines.push(`  ${group} (${count})`);
    }
    const point = n === state.cursor ? POINTER : ' ';
    const mark = item.checked ? CHECKED : UNCHECKED;
    lines.push(`  ${point} ${mark} ${item.label.padEnd(width)}  ${item.note}`.trimEnd());
  });

  return [...lines, '', ...LEGEND];
}

// node:readline reports a shifted letter as {name: 'a', shift: true} while the
// raw string carries the actual character. Reading the string keeps `a` and `A`
// distinct without depending on which of the two the platform fills in.
export function keyName(str, key = {}) {
  if (key.ctrl && key.name === 'c') return 'ctrl-c';
  if (['up', 'down', 'space', 'return', 'escape'].includes(key.name)) return key.name;
  if (typeof str === 'string' && /^[ajknAJKNQq]$/.test(str)) return str === 'Q' ? 'q' : str;
  return null;
}

// Returns the selected keys, or null when the user cancelled or there was no
// TTY to ask on. An empty item list is answered immediately with [] — having
// nothing to choose is not the same as being unable to choose.
export async function select(items, {
  title = 'select',
  input = process.stdin,
  output = process.stdout,
  isTTY = process.stdin.isTTY,
} = {}) {
  if (items.length === 0) return [];
  if (!isTTY) return null;

  let state = initialState(items);
  let drawn = 0;

  const draw = () => {
    // Move back over what was drawn last time and clear forward, so the list
    // redraws in place instead of scrolling a new copy for every keystroke.
    if (drawn) output.write(`\x1b[${drawn}A\x1b[0J`);
    const lines = render(state, { title });
    output.write(lines.join('\n') + '\n');
    drawn = lines.length;
  };

  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  if (input.setRawMode) input.setRawMode(true);
  output.write('\x1b[?25l'); // hide the cursor; the pointer is the cursor here

  try {
    return await new Promise((resolve) => {
      const onKey = (str, key) => {
        const name = keyName(str, key);
        if (!name) return;
        const next = reduce(state, name);
        state = next.state;
        if (next.done) {
          input.off('keypress', onKey);
          resolve(next.done === 'confirm' ? selectedKeys(state) : null);
          return;
        }
        draw();
      };
      input.on('keypress', onKey);
      draw();
    });
  } finally {
    // Restore unconditionally. A terminal left in raw mode with a hidden
    // cursor outlives the process and takes the user's shell with it.
    output.write('\x1b[?25h');
    if (input.setRawMode) input.setRawMode(Boolean(wasRaw));
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS. The suite must still finish in a couple of seconds — if it hangs, `select` reached the keypress loop without a TTY, which the `isTTY` guard is there to prevent.

- [ ] **Step 5: Commit**

```bash
git add src/select.mjs test/select-render.test.mjs
git commit -m "feat: render the multi-select and drive it from raw-mode keypresses"
```

---

### Task 3: One clone yields trees and the skill list (`src/git-trees.mjs`)

**Files:**
- Modify: `src/git-trees.mjs`
- Modify: `test/git-trees.test.mjs`
- Modify: `test/update.test.mjs` (fixtures only — see Step 3)

**Interfaces:**
- Produces:
  - `buildLsTreeArgs() -> string[]` → `['ls-tree', '-r', 'HEAD', '--name-only']`
  - `inspectSource(sourceUrl, paths, {run}) -> Promise<{trees: Map<path, sha|null>, skillPaths: string[]} | null>` — `null` means the clone failed. `skillPaths` is every path in the repo ending in `SKILL.md`.
- Removes: `resolveTrees`. Its only caller is `src/commands/update.mjs`.

- [ ] **Step 1: Write the failing test**

In `test/git-trees.test.mjs`, replace the import line and every `resolveTrees(` call with `inspectSource(`, adjusting each assertion to read `.trees` — for example `(await inspectSource(URL, ['skills/tdd'])).trees.get('skills/tdd')`. The clone-failure test still asserts the whole return is `null`. Then append:

```js
import { buildLsTreeArgs } from '../src/git-trees.mjs';

test('buildLsTreeArgs lists every path at HEAD without checking anything out', () => {
  assert.deepEqual(buildLsTreeArgs(), ['ls-tree', '-r', 'HEAD', '--name-only']);
});

test('inspectSource returns every SKILL.md path in the repo', async () => {
  const res = await inspectSource(ORIGIN_URL, ['skills/tdd']);
  assert.deepEqual(res.skillPaths, ['skills/tdd/SKILL.md']);
});

test('inspectSource returns skill paths even when no tree paths were asked for', async () => {
  const res = await inspectSource(ORIGIN_URL, []);
  assert.deepEqual([...res.trees], []);
  assert.deepEqual(res.skillPaths, ['skills/tdd/SKILL.md'], 'the listing is independent of the SHA lookups');
});

test('inspectSource ignores files that merely contain SKILL.md in their name', async () => {
  const res = await inspectSource(ORIGIN_URL, []);
  assert.ok(!res.skillPaths.some((p) => p.endsWith('NOT-SKILL.md')));
});
```

Extend the fixture repo at the top of the file so the last test has something to exclude — after the existing `writeFileSync` for `skills/tdd/SKILL.md`, add:

```js
writeFileSync(join(origin, 'skills', 'tdd', 'NOT-SKILL.md'), 'decoy\n');
```

This must be written **before** the fixture's `git add .` and commit.

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `inspectSource is not a function`, plus failures in `test/update.test.mjs` because `deps.resolveTrees` no longer matches.

- [ ] **Step 3: Write the implementation**

In `src/git-trees.mjs`, add the args builder and replace `resolveTrees` with `inspectSource`:

```js
export function buildLsTreeArgs() {
  return ['ls-tree', '-r', 'HEAD', '--name-only'];
}

// Both facts the caller needs come out of one clone: the tree SHA per known
// skill folder, and every SKILL.md in the repo so a skill that is not installed
// yet can still be seen. Splitting these into two exported functions would
// double the clones per source to save renaming one function.
//
// Returns null if the source could not be cloned — the caller reports every
// skill from that source as unknown rather than assuming it is current. A path
// present in `trees` with a null value exists in the lock but no longer exists
// upstream.
export async function inspectSource(sourceUrl, paths, { run = runGit } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-trees-'));
  try {
    const cloned = await run(buildCloneArgs(sourceUrl, dir));
    if (cloned.code !== 0) return null;

    const trees = new Map();
    for (const path of paths) {
      const res = await run(buildRevParseArgs(path), { cwd: dir });
      // A non-zero exit here is git saying the path is not in HEAD, which is a
      // real answer about the skill, not a failure of the check.
      trees.set(path, res.code === 0 && res.out ? res.out : null);
    }

    const listed = await run(buildLsTreeArgs(), { cwd: dir });
    const skillPaths = listed.code === 0
      ? listed.out.split('\n').map((l) => l.trim()).filter((p) => /(^|\/)SKILL\.md$/.test(p))
      : [];

    return { trees, skillPaths };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

Delete the old `resolveTrees` export. Note the empty-`paths` early return is gone: the listing is needed even when no SHA lookups are, so the clone now always happens.

In `src/commands/update.mjs`, update the import and the gather loop:

```js
import { inspectSource as realInspectSource } from '../git-trees.mjs';
```

and inside `run`'s destructuring, rename `resolveTrees = realResolveTrees` to `inspectSource = realInspectSource`, then change the loop body to:

```js
  for (const { sourceUrl, paths } of sourcesOf(entries)) {
    const found = await inspectSource(sourceUrl, paths);
    if (found) remoteTrees.set(sourceUrl, found.trees);
  }
```

In `test/update.test.mjs`, rename every `resolveTrees:` dep key to `inspectSource:` and wrap each fake's return value: `async () => new Map([...])` becomes `async () => ({ trees: new Map([...]), skillPaths: [] })`. The unreachable-source fakes returning `null` stay `null`.

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS, with no remaining reference to `resolveTrees`. Confirm with:

```bash
grep -rn "resolveTrees" src test | cat
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/git-trees.mjs src/commands/update.mjs test/git-trees.test.mjs test/update.test.mjs
git commit -m "feat: return upstream skill paths from the same clone as the tree SHAs"
```

---

### Task 4: Available-skill discovery (`src/skill-updates.mjs`)

**Files:**
- Modify: `src/skill-updates.mjs` (append)
- Modify: `test/skill-updates.test.mjs` (append)

**Interfaces:**
- Consumes: `skillFolder` (already in this file).
- Produces:
  - `upstreamSkills(skillPaths) -> Array<{path, name}>` — sorted by name, nested `SKILL.md` dropped, repo-root `SKILL.md` skipped.
  - `availableSkills({upstreamBySource, installedNames}) -> Array<{name, source}>` — sorted by name, one entry per name.
  - `upstreamBySource` is `Map<source, Array<{path, name}>>`.

- [ ] **Step 1: Write the failing test**

Append to `test/skill-updates.test.mjs`:

```js
import { upstreamSkills, availableSkills } from '../src/skill-updates.mjs';

test('upstreamSkills names a skill after its folder', () => {
  assert.deepEqual(upstreamSkills(['skills/engineering/tdd/SKILL.md']), [
    { path: 'skills/engineering/tdd', name: 'tdd' },
  ]);
});

test('upstreamSkills sorts by name', () => {
  const names = upstreamSkills(['s/zebra/SKILL.md', 's/apple/SKILL.md']).map((s) => s.name);
  assert.deepEqual(names, ['apple', 'zebra']);
});

test('upstreamSkills drops a SKILL.md nested inside another skill', () => {
  // A SKILL.md under an existing skill's folder is a sub-resource, not a
  // second skill — counting it would invent one that could never install.
  const found = upstreamSkills(['s/tdd/SKILL.md', 's/tdd/references/deep/SKILL.md']);
  assert.deepEqual(found.map((s) => s.name), ['tdd']);
});

test('upstreamSkills keeps siblings that merely share a prefix', () => {
  const found = upstreamSkills(['s/tdd/SKILL.md', 's/tdd-extra/SKILL.md']);
  assert.deepEqual(found.map((s) => s.name), ['tdd', 'tdd-extra']);
});

test('upstreamSkills skips a repo-root SKILL.md', () => {
  // Its installed name comes from the repo, which this listing cannot derive.
  assert.deepEqual(upstreamSkills(['SKILL.md', 's/tdd/SKILL.md']).map((s) => s.name), ['tdd']);
});

test('upstreamSkills on nothing is empty', () => {
  assert.deepEqual(upstreamSkills([]), []);
});

test('availableSkills excludes what is already installed', () => {
  const bySource = new Map([['o/r', [{ path: 's/tdd', name: 'tdd' }, { path: 's/new', name: 'new' }]]]);
  assert.deepEqual(availableSkills({ upstreamBySource: bySource, installedNames: ['tdd'] }), [
    { name: 'new', source: 'o/r' },
  ]);
});

test('availableSkills is empty when a source offers nothing new', () => {
  const bySource = new Map([['o/r', [{ path: 's/tdd', name: 'tdd' }]]]);
  assert.deepEqual(availableSkills({ upstreamBySource: bySource, installedNames: ['tdd'] }), []);
});

test('availableSkills reports each source separately', () => {
  const bySource = new Map([
    ['o/one', [{ path: 's/a', name: 'a' }]],
    ['o/two', [{ path: 's/b', name: 'b' }]],
  ]);
  assert.deepEqual(availableSkills({ upstreamBySource: bySource, installedNames: [] }), [
    { name: 'a', source: 'o/one' },
    { name: 'b', source: 'o/two' },
  ]);
});

test('availableSkills lists a name offered by two sources only once', () => {
  const bySource = new Map([
    ['o/one', [{ path: 's/dup', name: 'dup' }]],
    ['o/two', [{ path: 's/dup', name: 'dup' }]],
  ]);
  const found = availableSkills({ upstreamBySource: bySource, installedNames: [] });
  assert.equal(found.length, 1, 'installing the same name twice is not a thing that can happen');
  assert.equal(found[0].source, 'o/one', 'the first source in iteration order wins');
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `upstreamSkills is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/skill-updates.mjs`:

```js
import { basename } from 'node:path';

// Every SKILL.md in a source repo, reduced to the skills it would install as.
// A skill's installed name is its folder name, so the mapping is structural —
// but two shapes have to be rejected first.
export function upstreamSkills(skillPaths) {
  const folders = skillPaths
    .map((p) => skillFolder(p))
    // A repo-root SKILL.md makes the repo itself one skill, taking its name
    // from the repo rather than the path. Nothing here can derive that, so it
    // is skipped rather than guessed at.
    .filter((dir) => dir !== '.')
    // Shallowest first, so the nesting check below always sees a parent before
    // any of its children.
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));

  const kept = [];
  for (const dir of folders) {
    // A SKILL.md beneath a folder that already holds one is a sub-resource.
    // The trailing slash matters: `s/tdd-extra` must not read as nested under
    // `s/tdd`.
    if (kept.some((k) => dir.startsWith(`${k}/`))) continue;
    kept.push(dir);
  }

  return kept
    .map((path) => ({ path, name: basename(path) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Upstream skills that are not installed here. Not a state of an installed
// skill — which is why it is computed separately from planUpdates rather than
// being a sixth bucket in it.
export function availableSkills({ upstreamBySource, installedNames }) {
  const installed = new Set(installedNames);
  const seen = new Set();
  const out = [];
  for (const [source, skills] of upstreamBySource) {
    for (const { name } of skills) {
      // Two sources can offer the same name, but only one folder can ever
      // exist under ~/.agents/skills, so the first source wins and the
      // duplicate is not offered twice.
      if (installed.has(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, source });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skill-updates.mjs test/skill-updates.test.mjs
git commit -m "feat: discover upstream skills that are not installed"
```

---

### Task 5: Manifest groups from disk (`src/skills.mjs`)

**Files:**
- Modify: `src/skills.mjs` (append)
- Modify: `test/skills.test.mjs` (append)

**Interfaces:**
- Consumes: `groupsFromLock` (already in this file).
- Produces: `installedGroups(lock, installedNames) -> Array<{source, skills: string[]}>` — `groupsFromLock`'s output with every skill whose folder is absent removed, and any group that empties dropped.

- [ ] **Step 1: Write the failing test**

Append to `test/skills.test.mjs`:

```js
import { installedGroups } from '../src/skills.mjs';

const locked = (skills) => ({ skills });
const meta = (source) => ({ source, sourceUrl: `https://github.com/${source}.git`, skillPath: 'x/SKILL.md' });

test('installedGroups keeps a skill whose folder is present', () => {
  const lock = locked({ tdd: meta('o/r') });
  assert.deepEqual(installedGroups(lock, ['tdd']), [{ source: 'o/r', skills: ['tdd'] }]);
});

test('installedGroups drops a lock entry whose folder is gone', () => {
  // The lock outlives the folder — this is the whole reason the function
  // exists, and why regenerating the manifest from the lock alone is wrong.
  const lock = locked({ tdd: meta('o/r'), ghost: meta('o/r') });
  assert.deepEqual(installedGroups(lock, ['tdd']), [{ source: 'o/r', skills: ['tdd'] }]);
});

test('installedGroups drops a source group that empties', () => {
  const lock = locked({ tdd: meta('o/one'), ghost: meta('o/two') });
  assert.deepEqual(installedGroups(lock, ['tdd']), [{ source: 'o/one', skills: ['tdd'] }]);
});

test('installedGroups includes a newly adopted skill', () => {
  const lock = locked({ tdd: meta('o/r'), wizard: meta('o/r') });
  assert.deepEqual(installedGroups(lock, ['tdd', 'wizard']), [
    { source: 'o/r', skills: ['tdd', 'wizard'] },
  ]);
});

test('installedGroups creates a group for a source new to the manifest', () => {
  const lock = locked({ tdd: meta('o/one'), fresh: meta('o/new') });
  assert.deepEqual(installedGroups(lock, ['tdd', 'fresh']), [
    { source: 'o/new', skills: ['fresh'] },
    { source: 'o/one', skills: ['tdd'] },
  ]);
});

test('installedGroups ignores a skill on disk with no lock entry', () => {
  // Hand-authored: nothing could install it, so it never enters the manifest.
  assert.deepEqual(installedGroups(locked({ tdd: meta('o/r') }), ['tdd', 'mine']), [
    { source: 'o/r', skills: ['tdd'] },
  ]);
});

test('installedGroups on a malformed lock is empty rather than throwing', () => {
  assert.deepEqual(installedGroups(null, ['tdd']), []);
  assert.deepEqual(installedGroups({ skills: 'nope' }, ['tdd']), []);
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `installedGroups is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/skills.mjs`:

```js
// groupsFromLock answers "what does the lock say was installed"; this answers
// "what is installed". They differ whenever a skill folder is removed without
// its lock entry, which is exactly the state a prune leaves behind — so a
// manifest regenerated from the lock alone would restore what a prune removed.
export function installedGroups(lock, installedNames) {
  const present = new Set(installedNames);
  return groupsFromLock(lock)
    .map((group) => ({ source: group.source, skills: group.skills.filter((n) => present.has(n)) }))
    .filter((group) => group.skills.length > 0);
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skills.mjs test/skills.test.mjs
git commit -m "feat: derive manifest groups from what is on disk, not from the lock"
```

---

### Task 6: Removal command (`src/skills-cli.mjs`)

**Files:**
- Modify: `src/skills-cli.mjs` (append)
- Modify: `test/skills-cli.test.mjs` (append)

**Interfaces:**
- Produces:
  - `buildRemoveCommand(names) -> {cmd, args}` → `npx -y skills remove <names…> --global --yes`
  - `runRemove(names, {dryRun}) -> Promise<boolean>` — `true` for an empty list, spawning nothing.

- [ ] **Step 1: Write the failing test**

Append to `test/skills-cli.test.mjs` (merge the new names into the existing import from `../src/skills-cli.mjs` rather than adding a second import line):

```js
test('buildRemoveCommand names every skill and stays global and non-interactive', () => {
  const { cmd, args } = buildRemoveCommand(['one', 'two']);
  assert.equal(cmd, 'npx');
  assert.deepEqual(args, ['-y', 'skills', 'remove', 'one', 'two', '--global', '--yes']);
});

test('buildRemoveCommand passes names positionally, like update and unlike add', () => {
  const { args } = buildRemoveCommand(['one', 'two']);
  assert.ok(!args.some((a) => a.includes(',')));
});

test('runRemove in dry-run spawns nothing and reports success', async () => {
  assert.equal(await runRemove(['one'], { dryRun: true }), true);
});

test('runRemove with nothing to remove spawns nothing', async () => {
  assert.equal(await runRemove([], { dryRun: false }), true, 'an empty list must not reach spawn');
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `buildRemoveCommand is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/skills-cli.mjs`:

```js
// `remove` takes bare positional names, the same shape as `update` and unlike
// `add --skill one,two`. --yes suppresses its confirmation prompt; nortuscc has
// already asked, and has already copied the folders into ~/.claude/backups/.
export function buildRemoveCommand(names) {
  return {
    cmd: 'npx',
    args: ['-y', 'skills', 'remove', ...names, '--global', '--yes'],
  };
}

export async function runRemove(names, { dryRun = false } = {}) {
  if (names.length === 0) return true;
  const command = buildRemoveCommand(names);
  if (dryRun) {
    console.log(`  ${command.cmd} ${command.args.join(' ')}`);
    return true;
  }
  console.log(`\nremoving ${names.length} skill(s)`);
  return runOne(command);
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skills-cli.mjs test/skills-cli.test.mjs
git commit -m "feat: build the skills remove command for a confirmed batch"
```

---

### Task 7: Plan-to-choices logic (`src/skill-actions.mjs`)

**Files:**
- Create: `src/skill-actions.mjs`
- Test: `test/skill-actions.test.mjs`

**Interfaces:**
- Consumes: a plan shaped `{current, outdated, gone, unknown, local, available}` where `available` is `Array<{name, source}>` from Task 4 and the rest come from the existing `planUpdates`.
- Produces:
  - `choices(plan, {seeded}) -> Array<{key, group, label, note, checked}>` — picker rows in group order `update`, `remove`, `add`. `seeded` is a `Set` of keys to force-check.
  - `actionsFrom(plan, keys) -> {update: string[], remove: string[], add: Array<{name, source}>}`
  - `seedKeys(plan, {add, prune}) -> Set<string>` — `add` is an array of names, `prune` a boolean.
  - Key format is `<action>:<name>` — `update:tdd`, `remove:to-issues`, `add:wizard`.

- [ ] **Step 1: Write the failing test**

Create `test/skill-actions.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choices, actionsFrom, seedKeys } from '../src/skill-actions.mjs';

const PLAN = {
  current: ['fine'],
  outdated: [{ name: 'tdd', source: 'o/r', from: 'aaaaaaa1', to: 'bbbbbbb2' }],
  gone: [{ name: 'to-issues', source: 'o/r', path: 's/to-issues' }],
  unknown: [],
  local: ['mine'],
  available: [{ name: 'wizard', source: 'o/r' }],
};

test('choices offers one row per actionable skill and nothing for current or local', () => {
  const rows = choices(PLAN, { seeded: new Set() });
  assert.deepEqual(rows.map((r) => r.key), ['update:tdd', 'remove:to-issues', 'add:wizard']);
});

test('choices groups rows as update, remove and add in that order', () => {
  assert.deepEqual(choices(PLAN, { seeded: new Set() }).map((r) => r.group), ['update', 'remove', 'add']);
});

test('choices checks outdated by default and leaves remove and add clear', () => {
  const rows = choices(PLAN, { seeded: new Set() });
  assert.deepEqual(rows.map((r) => r.checked), [true, false, false]);
});

test('choices checks a seeded row', () => {
  const rows = choices(PLAN, { seeded: new Set(['add:wizard']) });
  assert.equal(rows.find((r) => r.key === 'add:wizard').checked, true);
});

test('choices shows the SHA transition on an update row', () => {
  const row = choices(PLAN, { seeded: new Set() }).find((r) => r.key === 'update:tdd');
  assert.match(row.note, /aaaaaaa/);
  assert.match(row.note, /bbbbbbb/);
});

test('choices labels rows with the bare skill name', () => {
  assert.deepEqual(choices(PLAN, { seeded: new Set() }).map((r) => r.label), ['tdd', 'to-issues', 'wizard']);
});

test('choices on a plan with nothing actionable is empty', () => {
  const rows = choices(
    { current: ['a'], outdated: [], gone: [], unknown: [], local: ['b'], available: [] },
    { seeded: new Set() },
  );
  assert.deepEqual(rows, []);
});

test('choices tolerates a plan with no available key', () => {
  // planUpdates does not produce `available`; update.mjs merges it in. A plan
  // that lost it must not throw.
  const rows = choices({ ...PLAN, available: undefined }, { seeded: new Set() });
  assert.deepEqual(rows.map((r) => r.key), ['update:tdd', 'remove:to-issues']);
});

test('actionsFrom routes each selected key to its action', () => {
  const actions = actionsFrom(PLAN, ['update:tdd', 'remove:to-issues', 'add:wizard']);
  assert.deepEqual(actions.update, ['tdd']);
  assert.deepEqual(actions.remove, ['to-issues']);
  assert.deepEqual(actions.add, [{ name: 'wizard', source: 'o/r' }]);
});

test('actionsFrom on an empty selection is a no-op', () => {
  assert.deepEqual(actionsFrom(PLAN, []), { update: [], remove: [], add: [] });
});

test('actionsFrom ignores a key naming a skill not in the plan', () => {
  assert.deepEqual(actionsFrom(PLAN, ['update:ghost']).update, [], 'a stale key must not invent work');
});

test('actionsFrom keeps the source with each added skill', () => {
  // installGroups needs the source; losing it here would make the add
  // uninstallable with no obvious symptom.
  assert.equal(actionsFrom(PLAN, ['add:wizard']).add[0].source, 'o/r');
});

test('seedKeys with --prune checks every gone skill', () => {
  assert.deepEqual([...seedKeys(PLAN, { add: [], prune: true })], ['remove:to-issues']);
});

test('seedKeys with named adds checks only those', () => {
  assert.deepEqual([...seedKeys(PLAN, { add: ['wizard'], prune: false })], ['add:wizard']);
});

test('seedKeys ignores a named add that is not available', () => {
  assert.deepEqual([...seedKeys(PLAN, { add: ['nope'], prune: false })], []);
});

test('seedKeys with neither flag seeds nothing', () => {
  assert.deepEqual([...seedKeys(PLAN, { add: [], prune: false })], []);
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../src/skill-actions.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `src/skill-actions.mjs`:

```js
// Everything about what a selection *means* lives here, so the command module
// never branches on a skill's state: it hands a plan in and gets back the three
// lists its executors take.

const short = (sha) => (sha ? sha.slice(0, 7) : 'unknown');

const key = (action, name) => `${action}:${name}`;

// Groups double as action names, which is what makes the picker's "select all
// in this group" mean "update all of them" or "adopt all of them".
export function choices(plan, { seeded }) {
  const rows = [];
  const row = (action, name, note, source, checked) => ({
    key: key(action, name),
    group: action,
    label: name,
    note: `${note}  ${source}`,
    checked: checked || seeded.has(key(action, name)),
  });

  // Outdated is checked by default: refreshing what you already have is what
  // the command is for. Removing and adopting are opt-in.
  for (const o of plan.outdated) rows.push(row('update', o.name, `${short(o.from)} -> ${short(o.to)}`, o.source, true));
  for (const g of plan.gone) rows.push(row('remove', g.name, 'gone upstream', g.source, false));
  for (const a of plan.available ?? []) rows.push(row('add', a.name, 'available', a.source, false));
  return rows;
}

export function actionsFrom(plan, keys) {
  const chosen = new Set(keys);
  return {
    update: plan.outdated.filter((o) => chosen.has(key('update', o.name))).map((o) => o.name),
    remove: plan.gone.filter((g) => chosen.has(key('remove', g.name))).map((g) => g.name),
    // Filtering the plan rather than parsing the keys is what keeps a stale or
    // hand-typed key from inventing work, and is why `add` keeps its source.
    add: (plan.available ?? [])
      .filter((a) => chosen.has(key('add', a.name)))
      .map((a) => ({ name: a.name, source: a.source })),
  };
}

// Flags pre-check rows rather than bypassing the picker, so the same values
// drive the interactive and the scripted paths.
export function seedKeys(plan, { add, prune }) {
  const seeded = new Set();
  if (prune) for (const g of plan.gone) seeded.add(key('remove', g.name));
  const wanted = new Set(add);
  for (const a of plan.available ?? []) if (wanted.has(a.name)) seeded.add(key('add', a.name));
  return seeded;
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skill-actions.mjs test/skill-actions.test.mjs
git commit -m "feat: turn a plan and a selection into an action set"
```

---

### Task 8: Orchestration (`src/commands/update.mjs`)

**Files:**
- Modify: `src/commands/update.mjs`
- Modify: `test/update.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–7, plus `preserveCopy`, `backupDir`, `installGroups`, `runUpdate`, `emitManifest`, `manifestPath`, `readSkillsManifest`, `installedSkillNames`, `readSkillLock`.
- Produces:
  - `parseFlags(args) -> {check, yes, prune, add: string[], error: string|null}`
  - `manifestOutcome({groups, before, prunedCount}) -> {write: boolean, reason: string}`
  - `run(args, deps)` — `deps` gains `select`, `runRemove`, `installGroups`, `writeManifest`.
  - `exitCode({plan, failed, prunedNames})` — replaces `exitCode({plan, updateFailed})`. `gone` skills named in `prunedNames` no longer count toward exit 1.

- [ ] **Step 1: Write the failing test**

Append to `test/update.test.mjs`:

```js
import { parseFlags, manifestOutcome } from '../src/commands/update.mjs';

test('parseFlags reads --add as a comma list', () => {
  assert.deepEqual(parseFlags(['--add', 'a,b']).add, ['a', 'b']);
});

test('parseFlags accepts --add=a,b', () => {
  assert.deepEqual(parseFlags(['--add=a,b']).add, ['a', 'b']);
});

test('parseFlags rejects --add with no names', () => {
  // There is deliberately no way to adopt a whole repo from a flag.
  assert.match(parseFlags(['--add']).error, /--add/);
});

test('parseFlags reads --prune as a boolean', () => {
  assert.equal(parseFlags(['--prune']).prune, true);
  assert.equal(parseFlags([]).prune, false);
});

test('parseFlags refuses --check with an action flag', () => {
  assert.match(parseFlags(['--check', '--prune']).error, /--check/);
  assert.match(parseFlags(['--check', '--add', 'x']).error, /--check/);
  assert.match(parseFlags(['--check', '--yes']).error, /--check/);
});

test('parseFlags refuses an unknown flag', () => {
  assert.match(parseFlags(['--chek']).error, /--chek/);
});

test('manifestOutcome writes when nothing shrank', () => {
  const groups = [{ source: 'o/r', skills: ['a', 'b'] }];
  assert.equal(manifestOutcome({ groups, before: 2, prunedCount: 0 }).write, true);
});

test('manifestOutcome writes a shrink that the prune explains', () => {
  const groups = [{ source: 'o/r', skills: ['a'] }];
  assert.equal(manifestOutcome({ groups, before: 2, prunedCount: 1 }).write, true);
});

test('manifestOutcome refuses a shrink larger than the prune', () => {
  // The real hazard: a machine simply missing skills the shared manifest lists
  // would otherwise delete them for every other machine.
  const out = manifestOutcome({ groups: [{ source: 'o/r', skills: ['a'] }], before: 5, prunedCount: 1 });
  assert.equal(out.write, false);
  assert.match(out.reason, /--allow-shrink/);
});

test('manifestOutcome writes growth', () => {
  const groups = [{ source: 'o/r', skills: ['a', 'b', 'c'] }];
  assert.equal(manifestOutcome({ groups, before: 2, prunedCount: 0 }).write, true);
});

// --- orchestration ---

const AVAILABLE_DEPS = (overrides = {}) => ({
  readLock: () => ({ skills: { stale: entry('s/stale', 'old'), fresh: entry('s/fresh', 'same') } }),
  installed: () => ['fresh', 'stale'],
  inspectSource: async () => ({
    trees: new Map([['s/stale', 'new'], ['s/fresh', 'same']]),
    skillPaths: ['s/stale/SKILL.md', 's/fresh/SKILL.md', 's/wizard/SKILL.md'],
  }),
  select: async () => [],
  confirm: async () => true,
  preserve: () => '/b',
  runUpdate: async () => true,
  runRemove: async () => true,
  installGroups: async () => [],
  writeManifest: () => {},
  ...overrides,
});

test('the report lists an upstream skill that is not installed as available', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run(['--check'], AVAILABLE_DEPS());
  } finally { process.stdout.write = orig; }
  assert.match(chunks.join(''), /available.*wizard/s);
});

test('available skills never affect the exit code', async () => {
  // An active source repo almost always has something new; counting it would
  // leave --check permanently red and useless as a gate.
  const code = await run(['--check'], AVAILABLE_DEPS({
    inspectSource: async () => ({
      trees: new Map([['s/stale', 'old'], ['s/fresh', 'same']]),
      skillPaths: ['s/stale/SKILL.md', 's/fresh/SKILL.md', 's/wizard/SKILL.md'],
    }),
  }));
  assert.equal(code, 0, 'nothing outdated, gone or unknown — available alone must not fail');
});

test('the picker drives what gets executed', async () => {
  const sent = [];
  await run([], AVAILABLE_DEPS({
    select: async () => ['update:stale'],
    runUpdate: async (names) => { sent.push(...names); return true; },
  }));
  assert.deepEqual(sent, ['stale']);
});

test('a cancelled picker changes nothing and exits 0', async () => {
  let touched = false;
  const mark = async () => { touched = true; return true; };
  const code = await run([], AVAILABLE_DEPS({
    select: async () => null,
    runUpdate: mark, runRemove: mark, installGroups: mark,
  }));
  assert.equal(code, 0);
  assert.equal(touched, false);
});

test('an empty selection is a no-op that exits 0', async () => {
  let touched = false;
  const code = await run([], AVAILABLE_DEPS({
    select: async () => [],
    runUpdate: async () => { touched = true; return true; },
  }));
  assert.equal(code, 0);
  assert.equal(touched, false);
});

test('--yes skips the picker and updates everything outdated', async () => {
  let asked = false;
  const sent = [];
  await run(['--yes'], AVAILABLE_DEPS({
    select: async () => { asked = true; return []; },
    runUpdate: async (names) => { sent.push(...names); return true; },
  }));
  assert.equal(asked, false, '--yes must not open a picker');
  assert.deepEqual(sent, ['stale']);
});

test('--yes --add adopts exactly the named skills', async () => {
  const added = [];
  await run(['--yes', '--add', 'wizard'], AVAILABLE_DEPS({
    installGroups: async (groups) => { added.push(...groups.flatMap((g) => g.skills)); return []; },
  }));
  assert.deepEqual(added, ['wizard']);
});

test('--check refuses an action flag', async () => {
  assert.equal(await run(['--check', '--prune'], AVAILABLE_DEPS()), 2);
});

test('removals are backed up before anything is removed', async () => {
  const order = [];
  await run(['--yes', '--prune'], AVAILABLE_DEPS({
    inspectSource: async () => ({
      trees: new Map([['s/stale', null], ['s/fresh', 'same']]),
      skillPaths: ['s/fresh/SKILL.md'],
    }),
    preserve: () => { order.push('backup'); return '/b'; },
    runRemove: async () => { order.push('remove'); return true; },
  }));
  assert.deepEqual(order, ['backup', 'remove'], 'prune is the first thing that deletes a skill outright');
});

test('a pruned gone skill no longer forces exit 1', async () => {
  const code = await run(['--yes', '--prune'], AVAILABLE_DEPS({
    inspectSource: async () => ({
      trees: new Map([['s/stale', null], ['s/fresh', 'same']]),
      skillPaths: ['s/fresh/SKILL.md'],
    }),
  }));
  assert.equal(code, 0, 'a gone skill that was dealt with is not still a problem');
});

test('an unpruned gone skill still forces exit 1', async () => {
  const code = await run(['--yes'], AVAILABLE_DEPS({
    inspectSource: async () => ({
      trees: new Map([['s/stale', null], ['s/fresh', 'same']]),
      skillPaths: ['s/fresh/SKILL.md'],
    }),
  }));
  assert.equal(code, 1);
});

test('the manifest is written after adopting', async () => {
  let written = null;
  await run(['--yes', '--add', 'wizard'], AVAILABLE_DEPS({
    writeManifest: (text) => { written = text; },
  }));
  assert.ok(written, 'adopting a skill must record it in the manifest');
});

test('the manifest is left alone when nothing was adopted or pruned', async () => {
  let written = null;
  await run(['--yes'], AVAILABLE_DEPS({ writeManifest: (t) => { written = t; } }));
  assert.equal(written, null, 'a plain refresh changes no manifest entry');
});

test('a failing remover exits 1', async () => {
  const code = await run(['--yes', '--prune'], AVAILABLE_DEPS({
    inspectSource: async () => ({
      trees: new Map([['s/stale', null], ['s/fresh', 'same']]),
      skillPaths: ['s/fresh/SKILL.md'],
    }),
    runRemove: async () => false,
  }));
  assert.equal(code, 1);
});

test('a failing installer exits 1', async () => {
  const code = await run(['--yes', '--add', 'wizard'], AVAILABLE_DEPS({
    installGroups: async () => [{ source: 'o/r', ok: false }],
  }));
  assert.equal(code, 1);
});
```

Delete the two existing tests that assert on the old yes/no `confirm` prompt path — `'declining changes nothing and exits 0'` and `'no TTY without --yes refuses with exit 2 rather than hanging'` — and replace the latter with:

```js
test('no TTY and no --yes refuses with exit 2 rather than hanging', async () => {
  const code = await run([], AVAILABLE_DEPS({ select: async () => null, isTTY: false }));
  assert.equal(code, 2);
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `parseFlags is not a function`, plus orchestration failures.

- [ ] **Step 3: Write the implementation**

Rewrite `src/commands/update.mjs`. Keep `reportLines` and extend it with an `available` count row; replace the flag parsing, the prompt, and the execute block.

Keep the existing `const short = (sha) => (sha ? sha.slice(0, 7) : 'unknown');` at the top of the file — both `reportLines` and the closing report still use it, and it does not appear in the snippets below. Also keep the existing `gone` footer block in `reportLines` unchanged; `--prune` gives that advice a second route but does not replace it, since a run that prunes nothing still needs it.

The `confirm` import and `src/prompt.mjs` itself are no longer used by this command once the picker replaces the yes/no prompt. **Leave `src/prompt.mjs` and its tests in place** — deleting a tested module because its only caller changed is a separate decision, and the picker's non-TTY contract was modelled on it. Just drop the now-unused import from `update.mjs`, and confirm nothing else imports it:

```bash
grep -rn "prompt.mjs" src bin | cat
```

```js
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { planUpdates, updatableSkills, sourcesOf, upstreamSkills, availableSkills } from '../skill-updates.mjs';
import { inspectSource as realInspectSource } from '../git-trees.mjs';
import { select as realSelect } from '../select.mjs';
import { choices, actionsFrom, seedKeys } from '../skill-actions.mjs';
import { preserveCopy, backupDir } from '../backup.mjs';
import { runUpdate as realRunUpdate, runRemove as realRunRemove, installGroups as realInstallGroups } from '../skills-cli.mjs';
import { readSkillLock, installedSkillNames, installedGroups, emitManifest, manifestPath, readSkillsManifest } from '../skills.mjs';
import { agentsSkillsDir } from '../resolve.mjs';
import { formatRow, section, labelWidth } from '../report.mjs';

const FLAGS = new Set(['--check', '--yes', '--prune']);

const NEEDS_NAMES = '--add needs a comma-separated list of skill names';

export function parseFlags(args) {
  const out = { check: false, yes: false, prune: false, add: [], error: null };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--check') { out.check = true; continue; }
    if (arg === '--yes') { out.yes = true; continue; }
    if (arg === '--prune') { out.prune = true; continue; }

    // No bare --add: adopting a whole repo is exactly what a curated skill set
    // is not, so the names have to be said out loud. Both spellings funnel
    // through one place so neither can grow its own rule.
    let names = null;
    if (arg.startsWith('--add=')) {
      names = arg.slice('--add='.length);
    } else if (arg === '--add') {
      const next = args[i + 1];
      // A following flag is not a name list — `--add --prune` is a missing
      // argument, not an adoption of a skill called "--prune".
      if (next && !next.startsWith('-')) { names = next; i += 1; }
    } else if (!FLAGS.has(arg)) {
      out.error = `unknown option(s) for update: ${arg}`;
      return out;
    } else {
      continue;
    }

    out.add = (names ?? '').split(',').filter(Boolean);
    if (out.add.length === 0) { out.error = NEEDS_NAMES; return out; }
  }

  if (out.check && (out.yes || out.prune || out.add.length)) {
    out.error = '--check reports only; it cannot be combined with --yes, --add or --prune';
  }
  return out;
}

// A shrink of exactly what was pruned is the prune working. Anything larger is
// this machine missing skills the shared manifest lists, and writing it would
// delete them for every other machine.
export function manifestOutcome({ groups, before, prunedCount }) {
  const after = groups.reduce((n, g) => n + g.skills.length, 0);
  const shrink = before - after;
  if (shrink > prunedCount) {
    return {
      write: false,
      reason: `would drop ${shrink} entr(ies) but only ${prunedCount} were pruned; run 'nortuscc capture --allow-shrink' if that is intended`,
    };
  }
  return { write: true, reason: `${after} skill(s)` };
}

export function exitCode({ plan, failed, prunedNames = [] }) {
  if (failed) return 1;
  const pruned = new Set(prunedNames);
  const goneLeft = plan.gone.filter((g) => !pruned.has(g.name));
  if (goneLeft.length > 0 || plan.unknown.length > 0) return 1;
  return 0;
}
```

`reportLines` keeps its existing body; add an `available` count row after `local`, and leave the `gone` footer as it is:

```js
  if (plan.available?.length) {
    lines.push(formatRow('available', String(plan.available.length), plan.available.map((a) => a.name).join(', ')));
  }
```

Then `run`:

```js
export async function run(args = [], deps = {}) {
  const {
    inspectSource = realInspectSource,
    select = realSelect,
    runUpdate = realRunUpdate,
    runRemove = realRunRemove,
    installGroups = realInstallGroups,
    preserve = preserveCopy,
    readLock = readSkillLock,
    installed = installedSkillNames,
    writeManifest = (text) => writeFileSync(manifestPath(), text, 'utf8'),
    isTTY = process.stdin.isTTY,
  } = deps;

  const flags = parseFlags(args);
  if (flags.error) {
    console.error(`nortuscc: ${flags.error}`);
    console.error('Usage: nortuscc update [--check] [--yes] [--add <names>] [--prune]');
    return 2;
  }

  const lock = readLock();
  const installedNames = installed();
  const entries = updatableSkills(lock, installedNames);

  // One clone per source yields both the tree SHAs and the repo's full skill
  // list, so discovering what is available costs no extra network.
  const remoteTrees = new Map();
  const upstreamBySource = new Map();
  for (const { source, sourceUrl, paths } of sourcesOf(entries)) {
    const found = await inspectSource(sourceUrl, paths);
    if (!found) continue;
    remoteTrees.set(sourceUrl, found.trees);
    upstreamBySource.set(source, upstreamSkills(found.skillPaths));
  }

  const plan = {
    ...planUpdates({ lock, installedNames, remoteTrees }),
    available: availableSkills({ upstreamBySource, installedNames }),
  };
  process.stdout.write('\n' + section('update', reportLines(plan)));

  if (flags.check) {
    if (plan.outdated.length) process.stdout.write('\nRun: nortuscc update\n');
    return exitCode({ plan, failed: false });
  }

  const seeded = seedKeys(plan, { add: flags.add, prune: flags.prune });
  const rows = choices(plan, { seeded });
  if (rows.length === 0) return exitCode({ plan, failed: false });

  let keys;
  if (flags.yes) {
    // Scripted: take the defaults the picker would have shown, which is every
    // outdated skill plus whatever the flags seeded.
    keys = rows.filter((r) => r.checked).map((r) => r.key);
  } else {
    keys = await select(rows, { title: 'space to toggle, enter to confirm', isTTY });
    if (keys === null) {
      if (!isTTY) {
        console.error('\nnortuscc: no terminal to choose on. Re-run with --yes to take the defaults,\n  or with --check to report only.');
        return 2;
      }
      process.stdout.write('nothing selected\n');
      return exitCode({ plan, failed: false });
    }
  }

  const actions = actionsFrom(plan, keys);
  if (!actions.update.length && !actions.remove.length && !actions.add.length) {
    process.stdout.write('nothing selected\n');
    return exitCode({ plan, failed: false });
  }

  // Back up everything about to be removed or overwritten, before either
  // happens. --prune deletes outright, so this is the only copy.
  const touched = [...actions.remove, ...actions.update];
  let anyBackedUp = false;
  const unprotected = [];
  for (const name of touched) {
    if (preserve(join(agentsSkillsDir(), name), join('skills', name))) anyBackedUp = true;
    else unprotected.push(name);
  }
  if (anyBackedUp) process.stdout.write(`\nbacked up -> ${backupDir()}\n`);
  if (unprotected.length) {
    process.stdout.write(`\nno backup exists for: ${unprotected.join(', ')} (nothing was there to copy)\n`);
  }

  // Most destructive first, so a failure partway leaves the least to undo.
  let failed = false;
  if (actions.remove.length && !(await runRemove(actions.remove))) failed = true;
  if (actions.update.length && !(await runUpdate(actions.update))) failed = true;
  if (actions.add.length) {
    const bySource = new Map();
    for (const { name, source } of actions.add) {
      if (!bySource.has(source)) bySource.set(source, []);
      bySource.get(source).push(name);
    }
    const groups = [...bySource.entries()].map(([source, skills]) => ({ source, skills }));
    const results = await installGroups(groups);
    if (results.some((r) => !r.ok)) failed = true;
  }

  // The manifest is a statement about the machine, so it is rebuilt from the
  // machine — re-reading both the lock and the directory after the executors
  // ran, rather than diffing what we intended to do.
  if (actions.add.length || actions.remove.length) {
    const before = readSkillsManifest().reduce((n, g) => n + g.skills.length, 0);
    const groups = installedGroups(readLock(), installed());
    const outcome = manifestOutcome({ groups, before, prunedCount: actions.remove.length });
    if (outcome.write) {
      writeManifest(emitManifest(groups));
      process.stdout.write(`\nskills-manifest.txt written — ${outcome.reason}\n`);
      process.stdout.write('Run: nortuscc push -m "..."   to share it\n');
    } else {
      process.stdout.write(`\nskills-manifest.txt left alone — ${outcome.reason}\n`);
    }
  }

  const after = readLock();
  const movedInfo = plan.outdated
    .filter((o) => actions.update.includes(o.name))
    .map((o) => ({ o, to: after.skills?.[o.name]?.skillFolderHash ?? null }))
    .filter(({ o, to }) => o.from != null && to != null && to !== o.from);
  const width = labelWidth(movedInfo.map(({ o }) => o.name));
  process.stdout.write(
    '\n' + section('done', [
      ...movedInfo.map(({ o, to }) => formatRow(o.name, 'updated', `${short(o.from)} -> ${short(to)}`, width)),
      ...actions.remove.map((n) => formatRow(n, 'removed', '')),
      ...actions.add.map((a) => formatRow(a.name, 'added', a.source)),
    ]),
  );

  return exitCode({ plan, failed, prunedNames: actions.remove });
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/update.mjs test/update.test.mjs
git commit -m "feat: pick what to adopt, refresh and prune in one interactive pass"
```

---

### Task 9: Usage, README, and end-to-end verification

**Files:**
- Modify: `bin/nortuscc.mjs` (`USAGE`)
- Modify: `README.md`
- Modify: `test/cli.test.mjs`

**Interfaces:**
- Consumes: `run` from `src/commands/update.mjs`. `update` is already in `VERBS`; only the usage text changes.

- [ ] **Step 1: Write the failing test**

Append to `test/cli.test.mjs`, matching the file's existing spawn convention:

```js
test('usage documents the action flags', () => {
  const res = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(res.stdout, /--add/);
  assert.match(res.stdout, /--prune/);
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — usage mentions neither flag.

- [ ] **Step 3: Update the usage text**

In `bin/nortuscc.mjs`, replace the two `update` lines in `USAGE` with, keeping the existing column alignment:

```
  update [--check] [--yes]          adopt, refresh and prune skills, interactively
        [--add N,N] [--prune]       --check reports only; --add and --prune pre-tick rows
```

- [ ] **Step 4: Update the README**

Replace the `### Staying current` section's command block and add the picker. After the existing five-state paragraph, append:

````markdown
Run without `--check` and it becomes one interactive pass over every pending
decision:

```
  update (8)
  ❯ ◉ ask-matt                  c7d5778 -> c9c83b1   mattpocock/skills

  remove (3)
    ◯ to-issues                 gone upstream        mattpocock/skills

  add (14)
    ◯ wizard                    available            mattpocock/skills

  ↑↓ move · space toggle · a all in group · A all · n none in group · N none
  enter confirm · esc cancel
```

Outdated skills start ticked; removing and adopting are opt-in. `a` and `n`
act on the group under the cursor — the groups are the actions, so `a` means
"update all of these" or "adopt all of these" depending on where you are.

`--add wizard,wait-what` pre-ticks those rows; with `--yes` it acts on them
without asking. There is deliberately no flag that adopts a whole repo.
`--prune` pre-ticks every skill deleted upstream.

Adopting or pruning rewrites `skills-manifest.txt` from what is installed
afterwards, so the manifest and the machine cannot disagree about a change
`update` made. A shrink larger than the number pruned is refused — that means
this machine is missing skills the shared manifest lists, and writing it would
drop them for every other machine.
````

- [ ] **Step 5: Run the tests and verify they pass**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 6: Verify end to end**

```bash
node bin/nortuscc.mjs --help
node bin/nortuscc.mjs update --check
node bin/nortuscc.mjs update --check --prune   # must exit 2
node bin/nortuscc.mjs update --add             # must exit 2
```

`update --check` must now list an `available` row alongside `outdated` and `gone`, and must still write nothing. Confirm:

```bash
shasum -a 256 ~/.agents/.skill-lock.json
node bin/nortuscc.mjs update --check > /dev/null
shasum -a 256 ~/.agents/.skill-lock.json   # unchanged
git status --short                          # skills-manifest.txt untouched
```

**Do not run `node bin/nortuscc.mjs update` without `--check`** — that opens the picker and can modify the real skill set and the repo's manifest. Report instead if the interactive path needs exercising; that is the owner's call.

- [ ] **Step 7: Commit**

```bash
git add bin/nortuscc.mjs README.md test/cli.test.mjs
git commit -m "docs: document the interactive update and its action flags"
```

---

## Self-Review

**Spec coverage.** Picker and keys → Tasks 1–2. Group-scoped select-all with a cursor-in-middle-group test → Task 1. `inspectSource` replacing `resolveTrees` → Task 3. Available discovery, nesting rule, root `SKILL.md` → Task 4. `installedGroups` → Task 5. `buildRemoveCommand` → Task 6. `choices`/`actionsFrom`/`seedKeys` → Task 7. Flag modes, seeding, execution order, backups before removal, manifest rebuild, shrink guard, pruned-gone exit rule, `available` never affecting exit → Task 8. Usage and README → Task 9.

**Type consistency.** `choices` returns `{key, group, label, note, checked}`; `select`/`initialState` consume exactly that shape. `select` returns `string[]|null`, which Task 8 branches on for cancel. `inspectSource` returns `{trees, skillPaths}` in Task 3 and is destructured as such in Task 8. `availableSkills` returns `{name, source}`, matching what `choices`, `seedKeys`, `actionsFrom` and `installGroups` each expect. `exitCode` changes signature to `{plan, failed, prunedNames}` in Task 8 and every call site in that task uses the new shape.

**Known risk carried deliberately.** Task 8 rewrites the largest module on the branch and deletes two existing tests whose behaviour it replaces. The tests it deletes cover the old yes/no prompt, which no longer exists — the reviewer should confirm the replacement covers cancel and no-TTY at least as well.

**Not in this plan.** Pointing `capture` at `installedGroups`, which would fix the same lock-outlives-folder bug in `capture`. The spec records it under Follow-ups; it changes an existing command's output and deserves its own decision.
