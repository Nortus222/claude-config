import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { run, type SetupDeps } from '../src/commands/setup.ts';
import type { Choice } from '../src/select.ts';
import { installerCalls, machine, readJson, type Machine } from './support/cli.ts';

// The interactive setup, in process: a terminal is stood in for by deps, the machine is a temp one.

const ORIGINAL_ENV = { ...process.env };
test.after(() => { process.env = ORIGINAL_ENV; });

async function setup(m: Machine, args: string[], deps: SetupDeps): Promise<{ code: number; out: string }> {
  Object.assign(process.env, {
    PATH: `${m.bin}${delimiter}${ORIGINAL_ENV.PATH}`,
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
  const write = process.stdout.write;
  const log = console.log;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
    if (typeof chunk !== 'string') return write.call(process.stdout, chunk, ...rest);
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => { out += args.join(' ') + '\n'; };
  try {
    const code = await run(args, { isTTY: true, prerequisites: { tools: [] }, status: { cliState: () => ({ state: 'current' }) as never }, ...deps });
    return { code, out };
  } finally {
    process.stdout.write = write;
    console.log = log;
  }
}

for (const selected of [[], ['claude'], ['codex'], ['claude', 'codex']]) {
  test(`the config picker records ${JSON.stringify(selected)} before anything is written, and apply honours it`, async () => {
    const m = machine();
    let offered: Choice[] = [];
    const result = await setup(m, [], {
      selectConfig: async (choices) => {
        assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false);
        assert.equal(existsSync(join(m.codex, 'AGENTS.md')), false);
        assert.deepEqual(choices.map((row) => row.key), ['claude', 'codex']);
        return selected;
      },
      select: async (choices) => { offered = [...choices]; return []; },
    });
    assert.match(result.out, /--- status ---/);

    const overrides = readJson(join(m.state, 'overrides.json'));
    assert.deepEqual(overrides.configTargets, selected);
    assert.equal(overrides.manageConfig, selected.length > 0);
    assert.equal(readJson(join(m.state, 'state.json')).repo, m.repo);
    assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), selected.includes('claude'));
    assert.equal(existsSync(join(m.codex, 'AGENTS.md')), selected.includes('codex'));
    assert.equal(/T3 Code provider handoff/.test(result.out), selected.includes('codex'));
    // Skills alone declines the integrations too.
    assert.equal(offered.some((c) => c.key.startsWith('integration:')), selected.length > 0);
    assert.deepEqual(installerCalls(m), []);
  });
}

test('cancelling the config picker changes nothing and exits 0', async () => {
  const m = machine();
  const result = await setup(m, [], { selectConfig: async () => null });
  assert.equal(result.code, 0);
  assert.match(result.out, /cancelled; no configuration was changed/);
  assert.equal(existsSync(join(m.state, 'state.json')), false);
  assert.equal(existsSync(join(m.state, 'overrides.json')), false);
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false);
});

test('a config flag skips the picker; prerequisites are still offered on a terminal', async () => {
  const m = machine();
  let asked = 0;
  const result = await setup(m, ['--skills-only'], {
    selectConfig: async () => { throw new Error('the picker must not ask when a flag decided'); },
    prerequisites: { tools: [{ id: 'x', label: 'X', executables: ['nortuscc-no-such-tool'], brew: 'x', winget: 'x', url: 'u' }], confirm: async () => { asked += 1; return false; } },
    select: async () => [],
  });
  assert.match(result.out, /--- status ---/);
  assert.equal(asked, 1);
  assert.equal(readJson(join(m.state, 'overrides.json')).manageConfig, false);
});

test('a failed prerequisite stops setup before anything is recorded', async () => {
  const m = machine();
  const result = await setup(m, ['--with-config'], {
    prerequisites: {
      platform: 'linux',
      tools: [{ id: 'x', label: 'X', executables: ['nortuscc-no-such-tool'], brew: 'x', winget: 'x', url: 'u' }],
      confirm: async () => true,
    },
  });
  assert.equal(result.code, 1);
  assert.equal(existsSync(join(m.state, 'state.json')), false);
});

// runCommand turns Ctrl-C into an aborted signal; an install child dies, but setup must stop too.
test('Ctrl-C during prerequisites stops setup with 130 before anything is recorded', async () => {
  const m = machine();
  const result = await setup(m, ['--skills-only'], {
    prerequisites: {
      tools: [{ id: 'x', label: 'X', executables: ['nortuscc-no-such-tool'], brew: 'x', winget: 'x', url: 'u' }],
      confirm: async () => { process.emit('SIGINT'); return false; },
    },
    select: async () => { throw new Error('setup must not reach the install picker after Ctrl-C'); },
  });
  assert.equal(result.code, 130);
  assert.match(result.out, /cancelled; nothing was recorded/);
  assert.equal(existsSync(join(m.state, 'state.json')), false);
  assert.equal(existsSync(join(m.state, 'overrides.json')), false);
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false);
});
