import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Effect } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import type { MachineReport, Observed, Step } from '@nortuscc/machine';
import { installChoices, parseInstallFlags, reviewLines, runInstall, type InstallFlags } from '../src/install.ts';
import { openMachine } from '../src/machine.ts';
import type { Choice } from '../src/select.ts';
import { installerCalls, machine, probeCalls, type Machine } from './support/cli.ts';

// --- flags -------------------------------------------------------------------

test('install flags take --yes and every category opt-out', () => {
  const flags = parseInstallFlags(['--yes', '--no-hooks', '--no-mcp', '--no-plugins', '--no-skills']);
  assert.equal(flags.yes, true);
  assert.deepEqual([...flags.declined].sort(), ['hooks', 'mcp', 'plugins', 'skills']);
  assert.equal(flags.error, null);
});

test('no flags decline nothing and assume nothing', () => {
  assert.deepEqual(parseInstallFlags([]), { yes: false, declined: [], error: null, rest: [] });
});

// The same argv carries the command's own flags; swallowing them would drop, say, --take-repo.
test('flags the workflow does not own survive into rest', () => {
  const flags = parseInstallFlags(['--take-repo', '--yes', 'extra']);
  assert.equal(flags.yes, true);
  assert.deepEqual(flags.rest, ['--take-repo', 'extra']);
  assert.equal(flags.error, null);
});

test('an unknown category opt-out is refused, naming the valid ones', () => {
  assert.equal(
    parseInstallFlags(['--no-widgets']).error,
    'unknown option --no-widgets (expected one of --no-hooks, --no-mcp, --no-plugins, --no-skills)',
  );
});

// --- choices -----------------------------------------------------------------

const integration = (over: Partial<Observed>): Observed => ({
  key: 'integration:x', domain: 'integrations', target: 'claude', label: 'x', group: 'Claude plugins',
  state: 'missing', disposition: 'apply', ...over,
});
const skill = (over: Partial<Observed>): Observed => ({
  key: 'skill:y', domain: 'skills', label: 'y', group: 'a/b', state: 'missing', disposition: 'apply', ...over,
});

test('a missing, enabled integration starts checked', () => {
  const [choice] = installChoices([integration({})]);
  assert.deepEqual(choice, { key: 'integration:x', group: 'Claude plugins', label: 'x', note: '', checked: true });
});

test('an installed integration stays visible, unchecked and marked already installed', () => {
  const [choice] = installChoices([integration({ state: 'installed', disposition: 'in-sync' })]);
  assert.equal(choice!.checked, false);
  assert.equal(choice!.note, 'already installed');
});

test('an integration not enabled on this machine starts unchecked', () => {
  const [choice] = installChoices([integration({ disposition: 'excluded' })]);
  assert.equal(choice!.checked, false);
});

test('a blocked integration shows its reason and is never pre-ticked', () => {
  const [choice] = installChoices([integration({ state: 'blocked', disposition: 'blocked', note: 'set OPENAI_API_KEY first' })]);
  assert.equal(choice!.checked, false);
  assert.equal(choice!.note, 'blocked — set OPENAI_API_KEY first');
  const [unknown] = installChoices([integration({ state: 'unknown', disposition: 'blocked' })]);
  assert.equal(unknown!.note, 'blocked — a prerequisite is missing');
});

test('a required missing skill is checked; an optional one is offered unchecked', () => {
  const choices = installChoices([
    skill({}),
    skill({ key: 'skill:opt', label: 'opt', disposition: 'excluded', note: 'optional' }),
  ]);
  assert.deepEqual(choices.map((c) => [c.key, c.group, c.checked]), [
    ['skill:y', 'shared skills', true],
    ['skill:opt', 'shared skills', false],
  ]);
  assert.equal(choices[1]!.note, 'optional skill, select to install');
});

test('installed, undeclared and local skills and configuration are not offered', () => {
  const choices = installChoices([
    skill({ state: 'ok', disposition: 'in-sync' }),
    skill({ key: 'skill:extra', state: 'extra', disposition: 'undeclared' }),
    skill({ key: 'skill:mine', state: 'local', disposition: 'excluded' }),
    { key: 'config:claude:CLAUDE.md', domain: 'config', target: 'claude', label: 'CLAUDE.md', group: 'claude', state: 'repo-ahead', disposition: 'apply' },
  ]);
  assert.deepEqual(choices, []);
});

test('integrations come before skills, whatever order the report lists them in', () => {
  const choices = installChoices([skill({}), integration({})]);
  assert.deepEqual(choices.map((c) => c.key), ['integration:x', 'skill:y']);
});

// --- review ------------------------------------------------------------------

const desired = { files: [], skills: [], integrations: [], allow: {}, issues: [] } as unknown as DesiredConfig;
const report = (items: Observed[]): MachineReport => ({ desired, items, probeErrors: [] });
const step = (over: Partial<Step>): Step => ({
  key: 'integration:x', domain: 'integrations', action: 'install-integration', summary: 'claude plugin install x@m',
  touches: [], interruptible: true, ...over,
});

test('the review names each item and the exact command it will run', () => {
  const lines = reviewLines([
    step({}),
    step({ key: 'skills:install:a/b', domain: 'skills', action: 'install-skills', summary: 'installing 2 skill(s) from a/b', touches: ['skills/p', 'skills/q'] }),
  ], report([integration({})]));
  assert.deepEqual(lines, [
    '  Claude plugins',
    '    x  claude plugin install x@m',
    '',
    '  shared skills',
    '    p, q  installing 2 skill(s) from a/b',
  ]);
});

test('a review of nothing says so', () => {
  assert.deepEqual(reviewLines([], report([])), ['  nothing to do']);
});

// --- the workflow, against a temp machine with fake installers ----------------

// openMachine reads the process environment, so each run points it at `m` first.
async function install(m: Machine, flags: InstallFlags, options: {
  targets?: Array<'claude' | 'codex'>;
  select?: (choices: readonly Choice[]) => Promise<string[] | null>;
  confirm?: () => Promise<boolean | null>;
  isTTY?: boolean;
  path?: string;
} = {}) {
  Object.assign(process.env, {
    PATH: `${options.path ? options.path + delimiter : ''}${m.bin}${delimiter}${ORIGINAL_PATH}`,
    HOME: m.home,
    NORTUSCC_CLAUDE_DIR: m.claude,
    NORTUSCC_CODEX_DIR: m.codex,
    NORTUSCC_OPENROUTER_CODEX_DIR: m.openrouter,
    NORTUSCC_AGENTS_DIR: m.agents,
    NORTUSCC_STATE_DIR: m.state,
    NORTUSCC_REPO_DIR: m.repo,
    NORTUSCC_TEST_LOG: m.log,
  });
  let out = '';
  let err = '';
  const write = process.stdout.write;
  const error = console.error;
  // Strings are the workflow's output; the test runner's own reports are binary and pass through.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
    if (typeof chunk !== 'string') return write.call(process.stdout, chunk, ...rest);
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  console.error = (...args: unknown[]) => { err += args.join(' ') + '\n'; };
  try {
    const code = await Effect.runPromise(Effect.gen(function* () {
      const opened = yield* openMachine();
      return yield* runInstall(opened, {
        targets: options.targets ?? ['claude', 'codex'], flags, isTTY: options.isTTY ?? true,
        signal: new AbortController().signal,
        ...(options.select ? { select: options.select } : {}),
        ...(options.confirm ? { confirm: options.confirm } : {}),
      }).pipe(Effect.provide(opened.layer));
    }));
    return { code, out, err };
  } finally {
    process.stdout.write = write;
    console.error = error;
  }
}
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_ENV = { ...process.env };
test.after(() => { process.env = ORIGINAL_ENV; });

const CLAUDE_PLUGIN = 'integration:superpowers-claude';

test('the interactive flow selects, reviews, then confirms before installing only what was ticked', async () => {
  const m = machine();
  const seen: string[] = [];
  const result = await install(m, parseInstallFlags([]), {
    select: async (choices) => { seen.push('select'); assert.ok(choices.some((c) => c.key === CLAUDE_PLUGIN)); return [CLAUDE_PLUGIN]; },
    confirm: async () => { seen.push('confirm'); return true; },
  });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(seen, ['select', 'confirm']);
  assert.match(result.out, /about to install/);
  assert.match(result.out, /claude plugin install superpowers@claude-plugins-official/);
  assert.deepEqual(installerCalls(m), [{ cmd: 'claude', args: ['plugin', 'install', 'superpowers@claude-plugins-official'] }]);
  assert.match(result.out, /superpowers\s+installed/);
});

test('declining the confirmation installs nothing', async () => {
  const m = machine();
  const result = await install(m, parseInstallFlags([]), { select: async () => [CLAUDE_PLUGIN], confirm: async () => false });
  assert.equal(result.code, 0);
  assert.match(result.out, /declined; nothing was installed/);
  assert.deepEqual(installerCalls(m), []);
});

test('cancelling the picker installs nothing and never asks for confirmation', async () => {
  const m = machine();
  let asked = false;
  const result = await install(m, parseInstallFlags([]), { select: async () => null, confirm: async () => { asked = true; return true; } });
  assert.equal(result.code, 0);
  assert.match(result.out, /cancelled; nothing was installed/);
  assert.equal(asked, false);
  assert.deepEqual(installerCalls(m), []);
});

test('ticking nothing installs nothing', async () => {
  const m = machine();
  const result = await install(m, parseInstallFlags([]), { select: async () => [] });
  assert.equal(result.code, 0);
  assert.match(result.out, /nothing selected/);
  assert.deepEqual(installerCalls(m), []);
});

test('no terminal and no --yes refuses with exit 2', async () => {
  const m = machine();
  const result = await install(m, parseInstallFlags([]), { isTTY: false });
  assert.equal(result.code, 2);
  assert.match(result.err, /no terminal to choose on/);
  assert.deepEqual(installerCalls(m), []);
});

test('a ticked optional skill is installed', async () => {
  const m = machine();
  const result = await install(m, parseInstallFlags(['--no-plugins']), {
    select: async () => ['skill:explain'], confirm: async () => true,
  });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(installerCalls(m), [{
    cmd: 'npx', args: ['-y', 'skills', 'add', 'Nortus222/agent-skills', '--skill', 'explain', '--agent', 'claude-code', 'codex', '--global', '--yes'],
  }]);
  assert.match(result.out, /explain\s+installed/);
});

test('--no-plugins keeps plugins out of the picker, and --no-skills keeps skills out', async () => {
  const m = machine();
  let offered: string[] = [];
  await install(m, parseInstallFlags(['--no-plugins', '--no-skills']), { select: async (choices) => { offered = choices.map((c) => c.key); return []; } });
  assert.deepEqual(offered, []);
});

test('a failing installer is reported per item and fails the run', async () => {
  const m = machine();
  const failing = mkdtempSync(join(tmpdir(), 'nortuscc-failing-npx-'));
  writeFileSync(join(failing, 'npx'), '#!/bin/sh\nexit 3\n');
  chmodSync(join(failing, 'npx'), 0o755);
  const result = await install(m, parseInstallFlags(['--yes', '--no-plugins']), { path: failing });
  assert.equal(result.code, 1);
  assert.match(result.out, /show-me\s+failed\s+humanlayer\/skills — npx exited with 3/);
  assert.match(result.out, /item\(s\) failed\. See the output above for details\./);
});

test('an invalid integrations.json installs nothing and exits 2', async () => {
  const m = machine();
  writeFileSync(join(m.repo, 'integrations.json'), '{ "version": 1, "integrations": [{ "id": 3 }] }');
  const result = await install(m, parseInstallFlags(['--yes']));
  assert.equal(result.code, 2);
  assert.match(result.err, /nortuscc: integrations\.json is invalid; nothing was installed\./);
  assert.deepEqual(installerCalls(m), []);
});

test('a bad opt-out exits 2 before anything is inspected', async () => {
  const m = machine();
  const result = await install(m, parseInstallFlags(['--no-widgets']));
  assert.equal(result.code, 2);
  assert.match(result.err, /unknown option --no-widgets/);
});

test('--yes takes the ticked rows without opening the picker or asking', async () => {
  const m = machine();
  const never = async (): Promise<never> => { throw new Error('must not be called'); };
  const result = await install(m, parseInstallFlags(['--yes', '--no-skills']), { select: never, confirm: never, isTTY: true });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(installerCalls(m), [
    { cmd: 'claude', args: ['plugin', 'install', 'superpowers@claude-plugins-official'] },
    { cmd: 'codex', args: ['plugin', 'add', 'superpowers@openai-curated-remote'] },
  ]);
});

test('a machine with nothing left to install says so and exits 0 without a terminal', async () => {
  const m = machine();
  assert.equal((await install(m, parseInstallFlags(['--yes', '--no-skills']))).code, 0);
  const again = await install(m, parseInstallFlags(['--no-skills']), { isTTY: false });
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /nothing to install; everything selected is already in place/);
  assert.equal(installerCalls(m).length, 2);
});

test('declined plugins never probe the Codex CLI', async () => {
  const m = machine();
  const result = await install(m, parseInstallFlags(['--yes', '--no-plugins']));
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(probeCalls(m), []);
});

test('an unavailable Codex CLI is reported, its plugin left unticked, and skills still install', async () => {
  const m = machine({ codexUnavailable: true });
  const result = await install(m, parseInstallFlags(['--yes']));
  assert.equal(result.code, 0, result.err);
  assert.match(result.err, /^nortuscc: .*codex/im);
  assert.doesNotMatch(result.err, /integrations\.json is invalid/);
  const calls = installerCalls(m);
  assert.deepEqual(calls.filter((c) => c.cmd === 'codex'), []);
  assert.ok(calls.some((c) => c.cmd === 'npx'));
});
