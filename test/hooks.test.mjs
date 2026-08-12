import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installHook, inspectHook, hookCommand } from '../src/integrations/claude-hooks.mjs';

const ITEM = {
  id: 'nortuscc-demo-hook',
  label: 'demo hook',
  target: 'claude',
  type: 'hook',
  default: false,
  event: 'SessionStart',
  file: 'claude/hooks/nortuscc-hook.mjs',
};

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'nortuscc-hooks-'));
  const repo = join(home, 'repo');
  const claude = join(home, '.claude');
  mkdirSync(join(repo, 'claude', 'hooks'), { recursive: true });
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(repo, 'claude', 'hooks', 'nortuscc-hook.mjs'), '// hook body\n');

  const preserved = [];
  return {
    repo,
    claude,
    settings: join(claude, 'settings.json'),
    preserved,
    deps: {
      repo: () => repo,
      claudeDir: () => claude,
      settingsPath: join(claude, 'settings.json'),
      preserve: (path) => {
        preserved.push(path);
        return `${path}.backup`;
      },
    },
  };
}

test('hook registration preserves unrelated settings and hooks', async () => {
  const fx = fixture();
  writeFileSync(
    fx.settings,
    JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ command: 'mine' }] }] } }),
  );

  await installHook(ITEM, fx.deps);

  const after = JSON.parse(readFileSync(fx.settings, 'utf8'));
  assert.equal(after.theme, 'dark');
  assert.equal(after.hooks.Stop[0].hooks[0].command, 'mine');
  assert.match(JSON.stringify(after.hooks.SessionStart), /nortuscc-hook/);
});

// Permissions and preferences are the user's, not this tool's. Replacing the
// whole document — which is what copying settings.json used to do — is exactly
// the behaviour the design retires.
test('every unrelated key survives, not just the ones a test happened to name', async () => {
  const fx = fixture();
  const before = {
    theme: 'dark',
    permissions: { allow: ['Bash(gh pr view:*)'] },
    enabledPlugins: { 'a@b': true },
    statusLine: { type: 'command', command: 'x' },
  };
  writeFileSync(fx.settings, JSON.stringify(before));

  await installHook(ITEM, fx.deps);

  const after = JSON.parse(readFileSync(fx.settings, 'utf8'));
  for (const key of Object.keys(before)) {
    assert.deepEqual(after[key], before[key], `${key} must survive hook registration`);
  }
});

test('the settings file is backed up before it is changed', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, JSON.stringify({ theme: 'dark' }));

  await installHook(ITEM, fx.deps);

  assert.deepEqual(fx.preserved, [fx.settings], 'the local settings must be preserved before any edit');
});

test('the hook file is installed into the Claude hooks directory', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, '{}');

  const result = await installHook(ITEM, fx.deps);

  assert.equal(result.ok, true);
  const installed = join(fx.claude, 'hooks', 'nortuscc-hook.mjs');
  assert.ok(existsSync(installed));
  assert.equal(readFileSync(installed, 'utf8'), '// hook body\n');
});

// Re-running setup is meant to be idempotent and resumable. A second run that
// appended the same registration again would make the hook fire twice.
test('registering twice does not duplicate the entry', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, '{}');

  await installHook(ITEM, fx.deps);
  await installHook(ITEM, fx.deps);

  // Counted over the registrations themselves rather than over the serialized
  // JSON: the fixture's own temp directory is named `nortuscc-hooks-…`, so a
  // substring count of the whole document matches the path as well as the file.
  const after = JSON.parse(readFileSync(fx.settings, 'utf8'));
  const commands = after.hooks.SessionStart
    .flatMap((group) => group.hooks ?? [])
    .filter((hook) => hook.command.endsWith('nortuscc-hook.mjs'));
  assert.equal(commands.length, 1, 'the same hook must be registered exactly once');
});

// An unselected hook someone else installed is none of this tool's business.
test('an existing hook on the same event is kept alongside the new one', async () => {
  const fx = fixture();
  writeFileSync(
    fx.settings,
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'someone-elses-hook' }] }] } }),
  );

  await installHook(ITEM, fx.deps);

  const json = JSON.stringify(JSON.parse(readFileSync(fx.settings, 'utf8')).hooks.SessionStart);
  assert.match(json, /someone-elses-hook/, 'an unselected pre-existing hook must never be removed');
  assert.match(json, /nortuscc-hook/);
});

test('a missing settings file is created rather than treated as an error', async () => {
  const fx = fixture();
  const result = await installHook(ITEM, fx.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(fx.preserved, [], 'there is nothing to back up when no settings file exists');
  assert.match(JSON.stringify(JSON.parse(readFileSync(fx.settings, 'utf8'))), /nortuscc-hook/);
});

// A settings file that cannot be parsed must not be overwritten: it is the
// user's file, and replacing it with a fresh document would discard whatever
// they were mid-edit on.
test('a corrupt settings file is refused, not overwritten', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, '{ not json');

  const result = await installHook(ITEM, fx.deps);

  assert.equal(result.ok, false);
  assert.match(result.note, /settings/i);
  assert.equal(readFileSync(fx.settings, 'utf8'), '{ not json', 'the unreadable file must be left exactly as it was');
});

test('inspection reports a registered hook as installed and an absent one as missing', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, '{}');

  assert.equal(inspectHook(ITEM, fx.deps).state, 'missing');
  await installHook(ITEM, fx.deps);
  assert.equal(inspectHook(ITEM, fx.deps).state, 'installed');
});

test('the registered command points at the installed copy, not the repo', () => {
  const fx = fixture();
  const command = hookCommand(ITEM, fx.deps);
  assert.match(command, /nortuscc-hook\.mjs$/);
  assert.ok(command.includes(fx.claude), 'the hook must run from where it was installed');
  assert.ok(!command.includes(fx.repo), 'a repo path would break the moment the clone moves');
});
