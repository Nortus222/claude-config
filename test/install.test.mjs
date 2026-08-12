import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseInstallFlags } from '../src/install-plan.mjs';
import { runInstall } from '../src/commands/install.mjs';

// A fixture standing in for the three sections. Each section reports what it
// would do and records what it actually did, so the assertions read the real
// call order rather than an intention.
function fixtureDeps({
  isTTY = true,
  calls = [],
  fail = null,
  config = [
    { id: 'config:claude', label: 'CLAUDE.md', state: 'missing', default: true, describe: '~/.claude/CLAUDE.md' },
    { id: 'config:codex', label: 'AGENTS.md', state: 'missing', default: true, describe: '~/.codex/AGENTS.md' },
  ],
  integrations = [
    { id: 'plugin:x', type: 'plugin', group: 'Claude plugins', label: 'x', state: 'missing', default: true, describe: 'claude plugin install x' },
    { id: 'mcp:x', type: 'mcp', group: 'Codex MCP', label: 'mcp x', state: 'missing', default: true, describe: 'codex mcp add x' },
  ],
  skills = [
    { id: 'skill:y', label: 'y', state: 'missing', default: true, source: 'a/b', describe: 'npx skills add a/b --skill y' },
  ],
  select,
  confirm = async () => true,
} = {}) {
  const install = async (items) =>
    items.map((item) => {
      calls.push(item.id);
      return { id: item.id, label: item.label, ok: item.id !== fail, note: item.id === fail ? 'installer failed' : '' };
    });

  return {
    isTTY,
    select: select ?? (async (rows) => rows.filter((r) => r.checked).map((r) => r.key)),
    confirm,
    sections: {
      config: { items: () => config, install },
      integrations: { items: () => integrations, install },
      skills: { items: () => skills, install },
    },
  };
}

test('non-TTY setup refuses before install without --yes', async () => {
  const calls = [];
  const code = await runInstall({
    target: 'all',
    flags: parseInstallFlags([]),
    deps: fixtureDeps({ isTTY: false, calls }),
  });
  assert.equal(code, 2);
  assert.deepEqual(calls, []);
});

test('--yes installs defaults in dependency order and reports failures', async () => {
  const calls = [];
  const code = await runInstall({
    target: 'all',
    flags: parseInstallFlags(['--yes']),
    deps: fixtureDeps({ calls, fail: 'mcp:x' }),
  });
  assert.deepEqual(calls, ['config:claude', 'config:codex', 'plugin:x', 'mcp:x', 'skill:y']);
  assert.equal(code, 1);
});

test('--yes on a run where everything succeeds exits 0', async () => {
  const calls = [];
  const code = await runInstall({ target: 'all', flags: parseInstallFlags(['--yes']), deps: fixtureDeps({ calls }) });
  assert.equal(code, 0);
  assert.equal(calls.length, 5);
});

// --yes takes the defaults without opening the selector: a scripted run must
// never block on a picker nothing will answer.
test('--yes never opens the selector', async () => {
  let opened = false;
  const code = await runInstall({
    target: 'all',
    flags: parseInstallFlags(['--yes']),
    deps: fixtureDeps({ select: async () => { opened = true; return []; } }),
  });
  assert.equal(code, 0);
  assert.equal(opened, false);
});

test('an empty plan returns 0 without a TTY and without asking', async () => {
  const calls = [];
  const code = await runInstall({
    target: 'all',
    flags: parseInstallFlags([]),
    deps: fixtureDeps({ isTTY: false, calls, config: [], integrations: [], skills: [] }),
  });
  assert.equal(code, 0, 'nothing to do is not a failure to ask');
  assert.deepEqual(calls, []);
});

// Every declared item is already satisfied: re-running setup must be a no-op,
// which is what makes a partial first run safe to resume.
test('a plan of only satisfied items installs nothing and exits 0', async () => {
  const calls = [];
  const satisfied = (item) => ({ ...item, state: 'installed' });
  const code = await runInstall({
    target: 'all',
    flags: parseInstallFlags(['--yes']),
    deps: fixtureDeps({
      calls,
      config: [satisfied({ id: 'config:claude', label: 'CLAUDE.md', default: true })],
      integrations: [satisfied({ id: 'plugin:x', group: 'g', label: 'x', default: true })],
      skills: [satisfied({ id: 'skill:y', label: 'y', default: true })],
    }),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, []);
});

// --- interactive -------------------------------------------------------------

test('the interactive flow selects, reviews, then confirms before installing', async () => {
  const calls = [];
  const order = [];
  const code = await runInstall({
    target: 'all',
    flags: parseInstallFlags([]),
    deps: fixtureDeps({
      calls,
      select: async (rows) => { order.push('select'); return rows.filter((r) => r.checked).map((r) => r.key); },
      confirm: async () => { order.push('confirm'); return true; },
    }),
  });
  assert.equal(code, 0);
  assert.deepEqual(order, ['select', 'confirm']);
  assert.equal(calls.length, 5);
});

test('declining the confirmation changes nothing', async () => {
  const calls = [];
  const code = await runInstall({
    target: 'all',
    flags: parseInstallFlags([]),
    deps: fixtureDeps({ calls, confirm: async () => false }),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [], 'a declined confirmation must not install anything');
});

// select() returns null when the user cancelled. Cancelling is not declining
// a subset — it is asking for nothing at all to happen.
test('cancelling the selector changes nothing and never reaches the confirmation', async () => {
  const calls = [];
  let confirmed = false;
  const code = await runInstall({
    target: 'all',
    flags: parseInstallFlags([]),
    deps: fixtureDeps({
      calls,
      select: async () => null,
      confirm: async () => { confirmed = true; return true; },
    }),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, []);
  assert.equal(confirmed, false);
});

test('only the rows the user ticked are installed', async () => {
  const calls = [];
  const code = await runInstall({
    target: 'all',
    flags: parseInstallFlags([]),
    deps: fixtureDeps({ calls, select: async () => ['config:claude', 'skill:y'] }),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ['config:claude', 'skill:y']);
});

test('ticking nothing installs nothing', async () => {
  const calls = [];
  const code = await runInstall({
    target: 'all',
    flags: parseInstallFlags([]),
    deps: fixtureDeps({ calls, select: async () => [] }),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, []);
});

// --- category opt-outs -------------------------------------------------------

test('--no-skills keeps configuration and integrations but installs no skill', async () => {
  const calls = [];
  const code = await runInstall({
    target: 'all',
    flags: parseInstallFlags(['--yes', '--no-skills']),
    deps: fixtureDeps({ calls }),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ['config:claude', 'config:codex', 'plugin:x', 'mcp:x']);
});

test('opting out of every category leaves configuration alone and exits 0', async () => {
  const calls = [];
  const code = await runInstall({
    target: 'all',
    flags: parseInstallFlags(['--yes', '--no-hooks', '--no-mcp', '--no-plugins', '--no-skills']),
    deps: fixtureDeps({ calls }),
  });
  assert.equal(code, 0);
  // Configuration is not one of the four opt-out categories: it is the thing
  // this tool exists to sync, and `--no-*` only ever declines integrations.
  assert.deepEqual(calls, ['config:claude', 'config:codex']);
});

test('a bad flag exits 2 before anything is inspected or installed', async () => {
  const calls = [];
  const code = await runInstall({
    target: 'all',
    flags: parseInstallFlags(['--no-widgets']),
    deps: fixtureDeps({ calls }),
  });
  assert.equal(code, 2);
  assert.deepEqual(calls, []);
});
