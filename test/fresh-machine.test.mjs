import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(REPO, 'bin', 'nortuscc.mjs');

// A genuinely empty home: no ~/.claude, no ~/.codex, no ~/.agents, no state.
// Every path nortuscc can reach is inside it, so this acceptance test can
// never observe — or disturb — the developer's real machine.
function emptyHomeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'nortuscc-fresh-'));
  return {
    home,
    claude: join(home, '.claude'),
    codex: join(home, '.codex'),
    agents: join(home, '.agents', 'skills'),
    state: join(home, 'state'),
    log: join(home, 'installer.log'),
  };
}

// Fake `claude`, `codex` and `npx`, each modelling the surface of the tool it
// stands in for — they are not interchangeable:
//
//   claude  keeps plugin state in ~/.claude/plugins/*.json, which nortuscc reads
//   codex   has no such file; it answers `plugin list --json` and installs with
//           `plugin add` (there is no `plugin install`)
//   npx     drives the shared skill store
//
// Only mutating commands are logged, so the log means "what was installed".
// Everything written stays inside the test home: no network, no real installer.
function fakeNativeInstallers(env) {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-fake-bin-'));

  const script = (name) => `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const agent = ${JSON.stringify(name)};
const log = () => appendFileSync(process.env.NORTUSCC_TEST_LOG, JSON.stringify({ cmd: agent, args: argv }) + '\\n');

// Codex keeps its snapshots under an internal root and reports through its
// CLI, so the fake keeps a private file the CLI answers from rather than one
// nortuscc is allowed to read.
const codexState = join(process.env.NORTUSCC_CODEX_DIR, 'fake-codex-state.json');
function codexRead() {
  if (!existsSync(codexState)) return { plugins: [], marketplaces: [] };
  return JSON.parse(readFileSync(codexState, 'utf8'));
}
function codexWrite(state) {
  mkdirSync(process.env.NORTUSCC_CODEX_DIR, { recursive: true });
  writeFileSync(codexState, JSON.stringify(state));
}

function claudePatch(file, key) {
  const dir = join(process.env.NORTUSCC_CLAUDE_DIR, 'plugins');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const target = file === 'installed_plugins.json' ? (current.plugins ??= {}) : current;
  target[key] = {};
  writeFileSync(path, JSON.stringify(current));
}

// A marketplace registers under the name in its own manifest, which no rule
// derives from the source. Both real shapes are modelled here, as observed on
// a real machine: mksglu/context-mode registers as the repo name,
// thedotmack/claude-mem as the owner name.
const REGISTERED_AS = {
  'mksglu/context-mode': 'context-mode',
  'thedotmack/claude-mem': 'thedotmack',
};
const marketplaceName = (source) => REGISTERED_AS[String(source)] ?? String(source).split('/').pop();

if (agent === 'claude') {
  if (argv[0] === 'plugin' && argv[1] === 'marketplace' && argv[2] === 'add') {
    log(); claudePatch('known_marketplaces.json', marketplaceName(argv[3]));
  } else if (argv[0] === 'plugin' && argv[1] === 'install') {
    log(); claudePatch('installed_plugins.json', argv[2]);
  }
} else if (agent === 'codex') {
  if (argv[0] === 'plugin' && argv[1] === 'marketplace' && argv[2] === 'add') {
    log();
    const state = codexRead();
    state.marketplaces.push(marketplaceName(argv[3]));
    codexWrite(state);
  } else if (argv[0] === 'plugin' && argv[1] === 'add') {
    log();
    const state = codexRead();
    state.plugins.push(argv[2]);
    codexWrite(state);
  } else if (argv[0] === 'plugin' && argv[1] === 'marketplace' && argv[2] === 'list') {
    const state = codexRead();
    process.stdout.write(JSON.stringify({ marketplaces: state.marketplaces.map((name) => ({ name })) }));
  } else if (argv[0] === 'plugin' && argv[1] === 'list') {
    const state = codexRead();
    process.stdout.write(JSON.stringify({
      installed: state.plugins.map((pluginId) => ({ pluginId, installed: true })),
      available: [],
    }));
  } else if (argv[0] === 'plugin' && argv[1] === 'install') {
    // The real CLI has no such subcommand; failing loudly here is what keeps
    // this fixture honest about the bug it was written for.
    process.stderr.write("error: unrecognized subcommand 'install'\\n");
    process.exit(2);
  }
} else if (agent === 'npx') {
  if (argv[0] === '-y' && argv[1] === 'skills' && argv[2] === 'add') {
    log();
    const names = [];
    for (let i = argv.indexOf('--skill') + 1; i < argv.length && !argv[i].startsWith('--'); i += 1) {
      names.push(argv[i]);
    }
    const agents = [];
    for (let i = argv.indexOf('--agent') + 1; i > 0 && i < argv.length && !argv[i].startsWith('--'); i += 1) {
      agents.push(argv[i]);
    }
    // The real installer does two things per skill: it puts the skill in the
    // shared store, and it places a copy under the skills directory of every
    // agent named by --agent. Only the second makes the skill loadable, so a
    // fixture that did the first alone reported a machine whose skills no
    // agent could load as fully installed.
    const agentDirs = {
      'claude-code': process.env.NORTUSCC_CLAUDE_DIR,
      codex: process.env.NORTUSCC_CODEX_DIR,
    };
    for (const skill of names) {
      mkdirSync(join(process.env.NORTUSCC_AGENTS_DIR, skill), { recursive: true });
      for (const name of agents) {
        if (agentDirs[name]) mkdirSync(join(agentDirs[name], 'skills', skill), { recursive: true });
      }
    }
  }
}
`;

  for (const name of ['claude', 'codex', 'npx']) {
    const path = join(dir, name);
    writeFileSync(path, script(name));
    chmodSync(path, 0o755);
  }
  return dir;
}

function readInstallerLog(env) {
  if (!existsSync(env.log)) return [];
  return readFileSync(env.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runCli(args, { env, fixtureBinDir }) {
  const childEnv = {
    ...process.env,
    PATH: `${fixtureBinDir}${delimiter}${process.env.PATH}`,
    NORTUSCC_CLAUDE_DIR: env.claude,
    NORTUSCC_CODEX_DIR: env.codex,
    NORTUSCC_AGENTS_DIR: env.agents,
    NORTUSCC_STATE_DIR: env.state,
    NORTUSCC_REPO_DIR: REPO,
    NORTUSCC_TEST_LOG: env.log,
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { env: childEnv });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// Marketplaces before the plugins that come from them, and each agent's own
// CLI doing its own installing. Derived from the committed manifest's order,
// so this breaks loudly if a declaration is added without a decision about
// where it belongs.
// Since 2026-08-20 the manifest declares Superpowers for both agents and no
// marketplace: context-mode and claude-mem were dropped after a cost audit,
// and each agent uses its configured official marketplace.
function expectedDefaultInstallCalls() {
  return [
    { cmd: 'claude', args: ['plugin', 'install', 'superpowers@claude-plugins-official'] },
    { cmd: 'codex', args: ['plugin', 'add', 'superpowers@openai-curated'] },
  ];
}

test('fresh machine setup installs selected defaults for both agents', async () => {
  const env = emptyHomeFixture();
  const result = await runCli(['setup', '--target', 'all', '--yes'], {
    env,
    fixtureBinDir: fakeNativeInstallers(env),
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    readFileSync(join(env.claude, 'CLAUDE.md'), 'utf8'),
    readFileSync(join(REPO, 'claude', 'CLAUDE.md'), 'utf8'),
  );
  assert.equal(
    readFileSync(join(env.codex, 'AGENTS.md'), 'utf8'),
    readFileSync(join(REPO, 'codex', 'AGENTS.md'), 'utf8'),
  );

  const log = readInstallerLog(env);
  const nativeCalls = log.filter((entry) => entry.cmd !== 'npx');
  assert.deepEqual(nativeCalls, expectedDefaultInstallCalls());

  // Claude's settings.json is user-owned, but the declared keys are a
  // managed (merge-keys) entry now: a fresh machine with no file of its own
  // gets one created, carrying exactly the repo's declared keys.
  const settings = JSON.parse(readFileSync(join(env.claude, 'settings.json'), 'utf8'));
  const declared = JSON.parse(readFileSync(join(REPO, 'claude', 'settings.keys.json'), 'utf8'));
  assert.deepEqual(settings, declared);
});

test('every shared skill is installed for both agents, in one call per source', async () => {
  const env = emptyHomeFixture();
  const result = await runCli(['setup', '--target', 'all', '--yes'], {
    env,
    fixtureBinDir: fakeNativeInstallers(env),
  });
  assert.equal(result.code, 0, result.stderr);

  const skillCalls = readInstallerLog(env).filter((entry) => entry.cmd === 'npx' && entry.args[2] === 'add');
  assert.ok(skillCalls.length > 0, 'a fresh machine is missing every shared skill');

  for (const call of skillCalls) {
    const agentAt = call.args.indexOf('--agent');
    assert.ok(agentAt > 0, 'every add names its agents explicitly');
    assert.deepEqual(call.args.slice(agentAt, agentAt + 3), ['--agent', 'claude-code', 'codex']);
    assert.ok(call.args.includes('--global'));
    assert.ok(call.args.includes('--yes'));
  }

  // One invocation per source repo, not one per skill.
  const sources = skillCalls.map((call) => call.args[3]);
  assert.deepEqual([...new Set(sources)].sort(), sources.sort());
});

// Re-running setup is meant to be safe: it selects only incomplete work, which
// is what lets a partial first run be resumed by running it again.
test('a second setup run installs nothing and still exits 0', async () => {
  const env = emptyHomeFixture();
  const bin = fakeNativeInstallers(env);

  assert.equal((await runCli(['setup', '--target', 'all', '--yes'], { env, fixtureBinDir: bin })).code, 0);
  const afterFirst = readInstallerLog(env).length;

  const second = await runCli(['setup', '--target', 'all', '--yes'], { env, fixtureBinDir: bin });
  assert.equal(second.code, 0, second.stderr);

  const added = readInstallerLog(env).slice(afterFirst).filter((entry) => entry.cmd !== 'npx');
  assert.deepEqual(added, [], 'a satisfied machine must not re-run a single native installer');
});

test('a Codex-only setup never runs the Claude installer or writes ~/.claude', async () => {
  const env = emptyHomeFixture();
  const result = await runCli(['setup', '--target', 'codex', '--yes'], {
    env,
    fixtureBinDir: fakeNativeInstallers(env),
  });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(join(env.codex, 'AGENTS.md')));
  assert.equal(existsSync(join(env.claude, 'CLAUDE.md')), false);

  const log = readInstallerLog(env);
  assert.deepEqual(log.filter((entry) => entry.cmd === 'claude'), [], 'a Codex run must never invoke the Claude CLI');

  // Assert the Codex path did real work, without assuming the manifest declares
  // a Codex *integration* — since 2026-08-20 it declares none, so the only
  // Codex-native work left is installing skills.
  const skillAdds = log.filter((entry) => entry.cmd === 'npx' && entry.args[2] === 'add');
  assert.ok(skillAdds.length > 0, 'a Codex run must still install skills');

  for (const call of skillAdds) {
    const agentAt = call.args.indexOf('--agent');
    assert.deepEqual(call.args.slice(agentAt, agentAt + 2), ['--agent', 'codex']);
  }
});

test('a Claude-only setup never runs the Codex installer or writes ~/.codex', async () => {
  const env = emptyHomeFixture();
  const result = await runCli(['setup', '--target', 'claude', '--yes'], {
    env,
    fixtureBinDir: fakeNativeInstallers(env),
  });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(join(env.claude, 'CLAUDE.md')));
  assert.equal(existsSync(join(env.codex, 'AGENTS.md')), false);
  assert.deepEqual(readInstallerLog(env).filter((entry) => entry.cmd === 'codex'), []);
});

// Category opt-outs have to reach the child processes, not merely the report.
//
// The run still ends non-zero, and that is the honest answer: setup finishes
// with a status report, and a machine that declined its declared integrations
// and skills is genuinely not in agreement with the repo. The opt-out governs
// what gets installed, not what status is willing to say about the result.
test('--no-plugins and --no-skills reach the installers, not just the report', async () => {
  const env = emptyHomeFixture();
  const result = await runCli(['setup', '--target', 'all', '--yes', '--no-plugins', '--no-skills'], {
    env,
    fixtureBinDir: fakeNativeInstallers(env),
  });

  assert.deepEqual(readInstallerLog(env), [], 'declining every category must spawn nothing');

  // Configuration is not a declinable category, so it still landed.
  assert.ok(existsSync(join(env.claude, 'CLAUDE.md')));
  assert.ok(existsSync(join(env.codex, 'AGENTS.md')));

  assert.equal(result.code, 1, 'the closing status still reports what was declined as missing');
  assert.match(result.stdout, /--- status ---/, 'the run reached its status report rather than failing early');
});

// Without a terminal to choose on, an unattended run must refuse rather than
// block forever or silently pick for the user.
test('a non-TTY setup without --yes refuses and installs nothing', async () => {
  const env = emptyHomeFixture();
  const result = await runCli(['setup', '--target', 'all'], {
    env,
    fixtureBinDir: fakeNativeInstallers(env),
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--yes/);
  assert.deepEqual(readInstallerLog(env), []);
});

test('state lands in the neutral location, never inside an agent directory', async () => {
  const env = emptyHomeFixture();
  await runCli(['setup', '--target', 'all', '--yes'], { env, fixtureBinDir: fakeNativeInstallers(env) });

  assert.ok(existsSync(join(env.state, 'state.json')));
  assert.equal(existsSync(join(env.claude, '.nortuscc-lock.json')), false);

  const state = JSON.parse(readFileSync(join(env.state, 'state.json'), 'utf8'));
  // settings.json is a merge-keys entry: it is baselined per declared key,
  // never under the bare 'claude:settings.json' — that would mean the whole
  // file was treated as managed, which it is not.
  const declaredKeys = Object.keys(JSON.parse(readFileSync(join(REPO, 'claude', 'settings.keys.json'), 'utf8')));
  assert.deepEqual(
    Object.keys(state.files).sort(),
    [
      'claude:CLAUDE.md',
      'codex:AGENTS.md',
      'codex:config.toml',
      'codex:models-static.json',
      ...declaredKeys.map((k) => `claude:settings.json#${k}`),
    ].sort(),
  );
});
