import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Black-box harness: every run gets its own home, state, repo and fake
// installers, so a test can never observe or disturb the developer's machine.
// Definitions only: the test runner also loads this file, and it must not act.

export const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const BIN = join(REPO, 'bin', 'nortuscc.mjs');

export type Machine = {
  home: string; claude: string; codex: string; openrouter: string; agents: string; state: string;
  /** NORTUSCC_REPO_DIR. */
  repo: string;
  /** Fake executables dir, first on PATH. */
  bin: string;
  /** JSONL of mutating fake-installer calls: { cmd, args }. */
  log: string;
};

export type Call = { cmd: string; args: string[] };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
}

export function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const COPIED = ['claude', 'codex', 'integrations.json', 'skills-manifest.txt', 'package.json', 'package-lock.json'];

// A throwaway git repo holding the files the CLI syncs, committed once, with a
// bare `origin` the branch tracks so push and pull have somewhere to go.
function copyRepo(home: string): string {
  const repo = join(home, 'repo');
  const origin = join(home, 'origin.git');
  mkdirSync(repo, { recursive: true });
  for (const name of COPIED) cpSync(join(REPO, name), join(repo, name), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
  git(home, 'init', '-q', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return repo;
}

// repo: 'checkout' points NORTUSCC_REPO_DIR at this checkout (read-only
// commands only); 'copy' (default) makes a temp git repo of copies.
export function machine(options: { repo?: 'checkout' | 'copy'; codexUnavailable?: boolean } = {}): Machine {
  const home = mkdtempSync(join(tmpdir(), 'nortuscc-bb-'));
  const m: Machine = {
    home,
    claude: join(home, '.claude'),
    codex: join(home, '.codex'),
    openrouter: join(home, '.codex-openrouter-glm'),
    agents: join(home, '.agents', 'skills'),
    state: join(home, 'state'),
    repo: REPO,
    bin: fakeNativeInstallers({ codexUnavailable: options.codexUnavailable ?? false }),
    log: join(home, 'installer.log'),
  };
  if ((options.repo ?? 'copy') === 'copy') m.repo = copyRepo(home);
  return m;
}

// Fake `claude`, `codex` and `npx`, each modelling the surface of the tool it
// stands in for — they are not interchangeable:
//
//   claude  keeps plugin state in ~/.claude/plugins/*.json, which nortuscc reads
//   codex   has no such file; it answers `plugin list --json` and installs with
//           `plugin add` (there is no `plugin install`)
//   npx     drives the shared skill store
//
// Only mutating commands are logged to NORTUSCC_TEST_LOG, so that log means
// "what was installed". Every codex call, read-only ones too, also goes to
// NORTUSCC_TEST_LOG + '.probe'. Everything written stays inside the test home:
// no network, no real installer.
function fakeNativeInstallers({ codexUnavailable }: { codexUnavailable: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-fake-bin-'));

  const script = (name: string) => `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const agent = ${JSON.stringify(name)};
const log = () => appendFileSync(process.env.NORTUSCC_TEST_LOG, JSON.stringify({ cmd: agent, args: argv }) + '\\n');
// Every codex call, read-only ones included, so a test can prove a command
// never reached for codex at all.
if (agent === 'codex') appendFileSync(process.env.NORTUSCC_TEST_LOG + '.probe', JSON.stringify({ cmd: agent, args: argv, readOnly: true }) + '\\n');

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
    // shared store, and it places it under the skills directory of every
    // agent named by --agent. Only the second makes the skill loadable, so a
    // fixture that did the first alone reported a machine whose skills no
    // agent could load as fully installed. Claude's placement is a link into
    // the store, as the real installer makes it; a plain directory there reads
    // as an undeclared skill that did not come from the store.
    const agentDirs = {
      'claude-code': process.env.NORTUSCC_CLAUDE_DIR,
      codex: process.env.NORTUSCC_CODEX_DIR,
    };
    for (const skill of names) {
      const stored = join(process.env.NORTUSCC_AGENTS_DIR, skill);
      mkdirSync(stored, { recursive: true });
      for (const name of agents) {
        if (!agentDirs[name]) continue;
        const placed = join(agentDirs[name], 'skills', skill);
        if (name === 'claude-code') {
          mkdirSync(join(agentDirs[name], 'skills'), { recursive: true });
          if (!existsSync(placed)) symlinkSync(stored, placed, 'dir');
        } else {
          mkdirSync(placed, { recursive: true });
        }
      }
    }
  }
}
`;

  for (const name of ['claude', 'codex', 'npx']) {
    const path = join(dir, name);
    writeFileSync(
      path,
      name === 'codex' && codexUnavailable
        ? '#!/usr/bin/env node\nprocess.stderr.write("codex unavailable\\n"); process.exit(127);\n'
        : script(name),
    );
    chmodSync(path, 0o755);
  }
  return dir;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}

/** Mutating fake-installer calls, in order. */
export function installerCalls(m: Machine): Call[] {
  return readJsonl<Call>(m.log);
}

/** Every codex invocation, read-only ones included. */
export function probeCalls(m: Machine): Array<Call & { readOnly: true }> {
  return readJsonl<Call & { readOnly: true }>(m.log + '.probe');
}

// Runs the CLI against `m`. `bin` launches another copy of bin/nortuscc.mjs, such as an npx copy.
export function runCli(
  m: Machine,
  args: string[],
  options: { env?: Record<string, string>; input?: string; bin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    PATH: `${m.bin}${delimiter}${process.env.PATH}`,
    // Nothing may fall back to the developer's real home.
    HOME: m.home,
    USERPROFILE: m.home,
    NORTUSCC_CLAUDE_DIR: m.claude,
    NORTUSCC_CODEX_DIR: m.codex,
    NORTUSCC_OPENROUTER_CODEX_DIR: m.openrouter,
    NORTUSCC_AGENTS_DIR: m.agents,
    NORTUSCC_STATE_DIR: m.state,
    NORTUSCC_REPO_DIR: m.repo,
    NORTUSCC_TEST_LOG: m.log,
    ...options.env,
  };
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [options.bin ?? BIN, ...args], { env }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
    child.stdin?.end(options.input ?? '');
  });
}
