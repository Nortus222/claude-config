import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, machine, probeCalls, readJson, runCli, type Machine } from './support/cli.ts';

// `nortuscc status` from the outside: a temp machine, a temp repo and fake installers. Every
// machine uses a copied repo, so the cli section asks a local bare `origin`, never the network.

const status = (m: Machine, ...args: string[]) => runCli(m, ['status', ...args]);
const statePath = (m: Machine) => join(m.state, 'state.json');
const read = (path: string) => readFileSync(path, 'utf8');
const AGREEMENT = /everything is in agreement/;

// Configuration applied and every default integration and required skill installed.
async function synced(options: Parameters<typeof machine>[0] = {}, ...args: string[]): Promise<Machine> {
  const m = machine(options);
  assert.equal((await runCli(m, ['apply', ...args])).code, 0);
  const installed = await runCli(m, ['apply', '--install', '--yes', ...args]);
  assert.equal(installed.code, 0, installed.stderr);
  return m;
}

// Every path under `dir` with its contents (a link's target, a file's bytes), for read-only checks.
// The fake installers' own call logs are left out.
function snapshot(m: Machine): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(m.home, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (path.startsWith(m.log)) continue;
    out[path] = entry.isSymbolicLink() ? `-> ${readlinkSync(path)}` : entry.isFile() ? read(path) : '<dir>';
  }
  return out;
}

function writeIntegrations(m: Machine, document: unknown) {
  writeFileSync(join(m.repo, 'integrations.json'), JSON.stringify(document, null, 2) + '\n');
}

test('a fresh machine is reported dirty, and status writes nothing', async () => {
  const m = machine();
  const result = await status(m);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /^config$/m);
  assert.match(result.stdout, /CLAUDE\.md\s+unmanaged\s+never synced on this machine/);
  // A settings document whose keys all say the same thing is one row, not one per key.
  assert.match(result.stdout, /settings\.json\s+unmanaged/);
  assert.doesNotMatch(result.stdout, /settings\.json#/);
  // Declared integrations this machine lacks are actionable and name their fix.
  assert.match(result.stdout, /superpowers\s+missing/);
  assert.match(result.stdout, /^ {2}nortuscc apply --install$/m);
  // A required skill missing from the store is named.
  assert.match(result.stdout, /missing\s+\d+\s+.*code-review/);
  assert.match(result.stdout, /nortuscc apply {5}bring this machine up to date/);
  assert.doesNotMatch(result.stdout, AGREEMENT);
  // Sections in order, and no cli section for a current checkout.
  const order = ['config', 'integrations', 'skills', 'undeclared'].map((s) => result.stdout.search(new RegExp(`^${s}$`, 'm')));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((at) => at >= 0));
  assert.doesNotMatch(result.stdout, /^cli$/m);

  assert.equal(existsSync(statePath(m)), false);
  assert.equal(existsSync(join(m.state, 'overrides.json')), false);
  assert.equal(existsSync(join(m.state, 'backups')), false);
});

test('a synced machine is in agreement, and status changes nothing in its home', async () => {
  const m = await synced();
  const before = read(statePath(m));
  const home = snapshot(m);
  const result = await status(m);
  assert.deepEqual(snapshot(m), home);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /CLAUDE\.md\s+clean/);
  assert.match(result.stdout, /settings\.json\s+clean/);
  assert.doesNotMatch(result.stdout, /settings\.json#/);
  assert.match(result.stdout, /all declared\s+installed/);
  // Unselected optional skills are informational and need no repair.
  assert.match(result.stdout, /optional\s+4\s+deploy-mobile-apps, emws-api, explain, share-artifacts/);
  assert.doesNotMatch(result.stdout, /apply --install/);
  assert.match(result.stdout, /all categories\s+declared/);
  assert.match(result.stdout, AGREEMENT);
  assert.doesNotMatch(result.stdout, /^cli$/m);
  assert.equal(read(statePath(m)), before);
  assert.equal(existsSync(join(m.state, 'backups')), false);

  // --strict on a clean machine still agrees.
  const strict = await status(m, '--strict');
  assert.equal(strict.code, 0);
  assert.match(strict.stdout, AGREEMENT);
});

test('local edits read local-ahead; edits on both sides are a conflict with both resolutions named', async () => {
  const m = await synced();
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# local change\n');
  writeFileSync(join(m.codex, 'AGENTS.md'), '# codex local change\n');

  const ahead = await status(m);
  assert.equal(ahead.code, 1);
  assert.match(ahead.stdout, /CLAUDE\.md\s+local-ahead\s+local edits not in the repo/);
  // Codex drift is attributed to Codex's own file.
  assert.match(ahead.stdout, /AGENTS\.md\s+local-ahead/);
  assert.match(ahead.stdout, /nortuscc push -m {3}share local edits/);

  writeFileSync(join(m.repo, 'claude', 'CLAUDE.md'), '# repo change\n');
  const conflict = await status(m);
  assert.equal(conflict.code, 1);
  assert.match(conflict.stdout, /CLAUDE\.md\s+conflict\s+changed in the repo AND here/);
  assert.match(conflict.stdout, /conflicts need a decision:/);
  assert.match(conflict.stdout, /nortuscc apply --take-repo {4}discard the local version/);
  assert.match(conflict.stdout, /nortuscc capture --take-local keep the local version/);
  // Each command refuses the flag that runs against its own direction.
  assert.doesNotMatch(conflict.stdout, /apply --take-local/);
  assert.doesNotMatch(conflict.stdout, /capture --take-repo/);
});

test('a managed file whose repo source vanished is missing-repo, not agreement', async () => {
  const m = await synced();
  unlinkSync(join(m.repo, 'codex', 'AGENTS.md'));
  const result = await status(m);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /AGENTS\.md\s+missing-repo\s+listed in the manifest but absent from the repo/);
  assert.doesNotMatch(result.stdout, AGREEMENT);
});

test('one drifted settings key gets its own row, sized so the section stays aligned', async () => {
  const m = await synced();
  const settings = join(m.claude, 'settings.json');
  writeFileSync(settings, JSON.stringify({ ...readJson(settings), effortLevel: 'low' }, null, 2) + '\n');

  const result = await status(m);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /settings\.json#effortLevel local-ahead/);
  assert.doesNotMatch(result.stdout, /settings\.json#theme/);
  assert.doesNotMatch(result.stdout, /settings\.json\s+clean/);
  // A short label pads out to the long label's width, not the 16-column default.
  assert.match(result.stdout, /CLAUDE\.md {17}clean/);
});

test('an unparseable local settings file is blocked, and its hooks are unknown', async () => {
  const m = await synced();
  writeFileSync(join(m.claude, 'settings.json'), '{ not json');
  const result = await status(m);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /settings\.json\s+unparseable-local\s+the local file could not be parsed/);
  // An unreadable category is reported as unknown, never as declared.
  assert.match(result.stdout, /hooks\s+unknown/);
  assert.doesNotMatch(result.stdout, /all categories\s+declared/);
});

test('a refused settings.keys.json is invalid, not missing-repo', async () => {
  const m = await synced();
  writeFileSync(join(m.repo, 'claude', 'settings.keys.json'), JSON.stringify({ apiKey: 'x' }) + '\n');
  const result = await status(m);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /manifest\s+invalid\s+.*looks like a secret/);
  assert.doesNotMatch(result.stdout, /missing-repo|absent from the repo/);
});

test('--target claude never reaches for Codex, and Codex cannot change its exit code', async () => {
  const m = await synced({ codexUnavailable: true }, '--target', 'claude');
  const before = probeCalls(m).length;
  const result = await status(m, '--target', 'claude');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(probeCalls(m).length, before);
  assert.deepEqual(probeCalls(m), []);
  assert.match(result.stdout, /CLAUDE\.md\s+clean/);
  assert.doesNotMatch(result.stdout, /AGENTS\.md|config\.toml/);
  assert.match(result.stdout, AGREEMENT);
});

test('--target codex reports only what Codex owns', async () => {
  const m = machine();
  const codex = await status(m, '--target', 'codex');
  assert.match(codex.stdout, /AGENTS\.md/);
  assert.doesNotMatch(codex.stdout, /CLAUDE\.md|settings\.json/);
  assert.equal(codex.stdout.match(/superpowers\s+missing/g)?.length, 1);

  const claude = await status(m, '--target', 'claude');
  assert.match(claude.stdout, /CLAUDE\.md/);
  assert.doesNotMatch(claude.stdout, /AGENTS\.md|models-static\.json/);
  assert.equal(claude.stdout.match(/superpowers\s+missing/g)?.length, 1);
});

// Apply would skip a blocked item, so its note is the fix and apply is not offered.
test('a blocked integration names its own fix, is not offered apply, and still fails the run', async () => {
  const m = await synced();
  const state = join(m.codex, 'fake-codex-state.json');
  writeFileSync(state, JSON.stringify({ ...readJson(state), signedOut: true }));
  const result = await status(m, '--target', 'all');
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /superpowers\s+blocked\s+Codex is not offering its built-in 'openai-curated-remote' catalog/);
  assert.doesNotMatch(result.stdout, /apply --install/);
  assert.doesNotMatch(result.stdout, AGREEMENT);
});

// The plugin list carries Codex's whole remote catalog, so one status asks for it once.
test('status lists Codex plugins once', async () => {
  const m = await synced();
  const before = probeCalls(m).length;
  await status(m, '--target', 'codex');
  const lists = probeCalls(m).slice(before).filter((c) => c.args[0] === 'plugin' && c.args[1] === 'list');
  assert.equal(lists.length, 1);
});

test('an unavailable Codex CLI is unknown, not a missing install, and does not fail the run', async () => {
  const m = await synced({ codexUnavailable: true });
  const result = await status(m, '--target', 'all');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /superpowers\s+unknown\s+could not list Codex plugins/);
  // Re-running apply would use the same unavailable CLI, so it is not suggested.
  assert.doesNotMatch(result.stdout, /apply --install/);
  // The failed read is surfaced in the inventory rather than read as an empty machine.
  assert.match(result.stdout, /codex\s+unknown/);
  assert.doesNotMatch(result.stdout, AGREEMENT);
  // A category that could not be read is a finding --strict refuses to forgive.
  assert.equal((await status(m, '--strict')).code, 1);
});

test('skills-only reports the configuration as skipped, whether recorded or flagged, and writes nothing', async () => {
  const m = await synced();
  mkdirSync(m.state, { recursive: true });
  writeFileSync(join(m.state, 'overrides.json'), JSON.stringify({ version: 1, manageConfig: false }) + '\n');
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# private rules\n');
  const recorded = await status(m);
  assert.equal(recorded.code, 0, recorded.stdout);
  assert.match(recorded.stdout, /configuration\s+skills-only\s+not managed on this machine/);
  assert.doesNotMatch(recorded.stdout, /CLAUDE\.md/);

  // A never-migrated machine keeps its choice in state.json; status reads it and migrates nothing.
  const legacy = machine();
  mkdirSync(legacy.state, { recursive: true });
  writeFileSync(statePath(legacy), JSON.stringify({ version: 1, repo: null, skillsOnly: true, files: {} }, null, 2) + '\n');
  const fromState = await status(legacy);
  assert.match(fromState.stdout, /configuration\s+skills-only/);
  assert.equal(existsSync(join(legacy.state, 'overrides.json')), false);
  assert.equal(readJson(statePath(legacy)).skillsOnly, true);

  // The flag narrows this one report and records nothing.
  const flagged = machine();
  const once = await status(flagged, '--skills-only');
  assert.match(once.stdout, /configuration\s+skills-only/);
  assert.equal(existsSync(join(flagged.state, 'overrides.json')), false);
  assert.equal(existsSync(statePath(flagged)), false);
});

test('a saved Claude-only selection reports Codex configuration as not selected', async () => {
  const m = machine();
  mkdirSync(m.state, { recursive: true });
  writeFileSync(statePath(m), JSON.stringify({ version: 1, repo: null, configTargets: ['claude'], files: {} }, null, 2) + '\n');
  const result = await status(m);
  assert.match(result.stdout, /codex configuration\s+unmanaged\s+not selected on this machine/);
  assert.doesNotMatch(result.stdout, /AGENTS\.md/);
  assert.match(result.stdout, /CLAUDE\.md\s+unmanaged/);
});

test('undeclared items are reported and forgiven unless --strict', async () => {
  const m = await synced();
  const plugins = join(m.claude, 'plugins', 'installed_plugins.json');
  const installed = readJson(plugins);
  installed.plugins['claude-mem@thedotmack'] = [{ scope: 'user', version: '1.0.0' }];
  writeFileSync(plugins, JSON.stringify(installed));
  mkdirSync(join(m.claude, 'agents', 'awesome-claude-agents'), { recursive: true });

  const result = await status(m);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /plugins\s+claude-mem@thedotmack/);
  assert.match(result.stdout, /agents\s+awesome-claude-agents/);
  assert.match(result.stdout, /2 finding\(s\)\. Declare them in integrations\.json, or list them/);
  assert.match(result.stdout, /under "allow" to accept them\. --strict makes this exit non-zero\./);
  assert.doesNotMatch(result.stdout, AGREEMENT);

  assert.equal((await status(m, '--strict')).code, 1);
});

test('undeclared skips the agents\' own marketplaces and store links, and names what came from elsewhere', async () => {
  const m = await synced();
  writeFileSync(join(m.claude, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'claude-plugins-official': {} }));
  // A relative link into the store is the store, however it is spelled.
  mkdirSync(join(m.agents, 'relative-one'), { recursive: true });
  symlinkSync('../../.agents/skills/relative-one', join(m.claude, 'skills', 'relative-one'));
  mkdirSync(join(m.claude, 'skills', 'hand-placed'));
  symlinkSync(join(m.home, 'nowhere'), join(m.claude, 'skills', 'dangling'));
  mkdirSync(join(m.claude, 'agents', '.internal'), { recursive: true });
  symlinkSync(join(m.home, 'elsewhere'), join(m.claude, 'agents', 'linked-agents'));
  // An allow entry for one category never quietens another.
  mkdirSync(join(m.claude, 'agents', 'dx-devextreme@DevExpress-agent-skills'), { recursive: true });
  const settings = join(m.claude, 'settings.json');
  writeFileSync(settings, JSON.stringify({
    ...readJson(settings),
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /h/stray.mjs' }] }] },
  }));

  const result = await status(m);
  assert.equal(result.code, 0, result.stdout);
  const undeclared = result.stdout.slice(result.stdout.search(/^undeclared$/m));
  assert.doesNotMatch(undeclared, /claude-plugins-official|relative-one|\.internal/);
  assert.match(result.stdout, /skills\s+hand-placed\s+not from the shared store/);
  assert.match(result.stdout, /skills\s+dangling\s+broken link/);
  assert.match(result.stdout, /agents\s+linked-agents\s+-> .*elsewhere/);
  assert.match(result.stdout, /agents\s+dx-devextreme@DevExpress-agent-skills/);
  // A hook is matched on its command and displayed by its event.
  assert.match(result.stdout, /hooks\s+SessionStart\s+node \/h\/stray\.mjs/);
  assert.match(result.stdout, /5 finding\(s\)/);

  // Claude-side categories are not walked for a Codex-only report.
  const codex = await status(m, '--target', 'codex');
  assert.doesNotMatch(codex.stdout, /hand-placed|linked-agents|SessionStart/);
  assert.match(codex.stdout, /all categories\s+declared/);
});

test('undeclared honours allow, declared hooks and manifest defects together', async () => {
  const m = await synced();
  mkdirSync(join(m.repo, 'claude', 'hooks'), { recursive: true });
  writeFileSync(join(m.repo, 'claude', 'hooks', 'session.mjs'), '// test hook\n');
  writeIntegrations(m, {
    version: 1,
    allow: { agents: ['stray-agent'] },
    integrations: [
      { id: 'session-hook', label: 'session hook', target: 'claude', type: 'hook', default: true, event: 'SessionStart', file: 'claude/hooks/session.mjs' },
      { id: 'bad-plugin', label: 'bad plugin', target: 'claude', type: 'plugin', default: true, plugin: 'foo@undeclared-market' },
    ],
  });
  mkdirSync(join(m.claude, 'agents', 'stray-agent'), { recursive: true });
  const settings = join(m.claude, 'settings.json');
  writeFileSync(settings, JSON.stringify({
    ...readJson(settings),
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node ${join(m.claude, 'hooks', 'session.mjs')}` }] }] },
  }));

  const result = await status(m);
  assert.doesNotMatch(result.stdout, /stray-agent/);
  assert.doesNotMatch(result.stdout, /hooks\s+SessionStart/);
  assert.match(result.stdout, /manifest\s+foo@undeclared-market\s+marketplace 'undeclared-market' is not declared/);
});

test('--versions prints installed plugin versions and keeps the pending list and its hint', async () => {
  const m = await synced({}, '--target', 'claude');
  writeFileSync(
    join(m.claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'superpowers@claude-plugins-official': [{ scope: 'user', version: '6.3.0' }] } }),
  );

  const plain = await status(m);
  assert.doesNotMatch(plain.stdout, /6\.3\.0/);

  // Codex's superpowers is still missing on this machine.
  const detailed = await status(m, '--versions');
  assert.match(detailed.stdout, /superpowers\s+installed\s+6\.3\.0/);
  assert.match(detailed.stdout, /superpowers\s+missing\s+unknown/);
  assert.match(detailed.stdout, /^ {2}nortuscc apply --install$/m);
  assert.equal(detailed.code, 1);

  // An install record without a version is unknown, never a matching one.
  writeFileSync(join(m.claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ 'superpowers@claude-plugins-official': true }));
  const unversioned = await status(m, '--versions', '--target', 'claude');
  assert.match(unversioned.stdout, /superpowers\s+installed\s+unknown/);
});

test('an invalid integrations.json is reported and makes status exit non-zero', async () => {
  const m = await synced();
  writeIntegrations(m, { version: 1, integrations: [{ id: 'x', label: 'x', target: 'cursor', type: 'plugin', default: true, plugin: 'a@b' }] });
  const result = await status(m);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /manifest\s+invalid\s+.*unsupported target 'cursor'/);
});

test('a skill one agent cannot load is partial and pointed at update', async () => {
  const m = await synced();
  rmSync(join(m.claude, 'skills', 'tdd'));
  const result = await status(m);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /partial\s+1\s+tdd \(missing from claude-code\)/);
  assert.match(result.stdout, /^ {2}nortuscc update$/m);
  // The store already has it, so an install has nothing to offer.
  assert.doesNotMatch(result.stdout, /apply --install/);
  assert.doesNotMatch(result.stdout, AGREEMENT);
});

// Pins tdd's source (mattpocock/skills) and records tdd in the skills lock without a ref, as an install
// from an older pin would. The lock holds only this pinned entry, so `update --check` clones nothing.
function pinTddSourceWithLockEntry(m: Machine) {
  writeFileSync(join(m.repo, 'skill-pins.json'), JSON.stringify({ version: 1, pins: { 'mattpocock/skills': 'a'.repeat(40) } }));
  const lock = join(dirname(m.agents), '.skill-lock.json');
  const existing = existsSync(lock) ? JSON.parse(read(lock)) : {};
  const tdd = {
    source: 'mattpocock/skills', sourceUrl: 'https://github.com/mattpocock/skills.git',
    skillPath: 'skills/tdd/SKILL.md', skillFolderHash: 'x',
  };
  writeFileSync(lock, JSON.stringify({ ...existing, skills: { ...existing.skills, tdd } }));
}

test('a skill installed off its pin is reported and pointed at update', async () => {
  const m = await synced();
  pinTddSourceWithLockEntry(m);
  const result = await status(m);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /off-pin\s+\d+\s+.*\btdd \(installed at no pin, pinned to aaaaaaa\)/);
  assert.match(result.stdout, /^ {2}nortuscc update$/m);
  assert.doesNotMatch(result.stdout, AGREEMENT);

  // The advised command sees the same skill.
  const check = await runCli(m, ['update', '--check']);
  assert.equal(check.code, 1, check.stdout + check.stderr);
  assert.match(check.stdout, /off-pin\s+\d+\s+.*\btdd\b/);
});

test('off-pin and partial together point at update once', async () => {
  const m = await synced();
  pinTddSourceWithLockEntry(m);
  rmSync(join(m.claude, 'skills', 'show-me'));
  const result = await status(m);
  assert.equal(result.stdout.match(/^ {2}nortuscc update$/gm)?.length, 1);
});

test('a skill no selected agent can load is unlinked', async () => {
  const m = await synced();
  rmSync(join(m.claude, 'skills', 'tdd'));
  const result = await status(m, '--target', 'claude');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /unlinked\s+1\s+tdd/);
  assert.match(result.stdout, /^ {2}nortuscc update$/m);
});

test('an unreadable agent skill directory is unknown, not nothing exposed', async () => {
  const m = await synced();
  rmSync(join(m.claude, 'skills'), { recursive: true });
  writeFileSync(join(m.claude, 'skills'), 'not a directory');
  const result = await status(m, '--target', 'claude');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /exposure\s+unknown\s+could not read the skill directory for claude-code/);
});

test('a CLI behind its remote is reported without a prompt when there is no terminal', async () => {
  const m = await synced();
  const clone = mkdtempSync(join(tmpdir(), 'nortuscc-clone-'));
  git(clone, 'clone', '-q', join(m.home, 'origin.git'), '.');
  writeFileSync(join(clone, 'new.txt'), 'new\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'newer');
  git(clone, 'push', '-q', 'origin', 'main');
  const tip = git(clone, 'rev-parse', 'HEAD').slice(0, 7);

  const result = await status(m);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^cli$/m);
  assert.match(result.stdout, new RegExp(`nortuscc\\s+behind\\s+origin/main is at ${tip}`));
  assert.match(result.stdout, /nortuscc pull {5}update nortuscc itself/);
  assert.doesNotMatch(result.stdout, /Update nortuscc now\?/);
  // The rest of the report still prints.
  assert.match(result.stdout, /CLAUDE\.md\s+clean/);
});

test('an unreachable remote is reported but does not fail the run', async () => {
  const m = await synced();
  git(m.repo, 'remote', 'set-url', 'origin', join(m.home, 'gone.git'));
  const result = await status(m);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /nortuscc\s+unknown/);
});

test('an unknown --target exits 2 before reporting', async () => {
  const m = machine();
  const result = await status(m, '--target', 'x');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--target must be claude\|codex\|all/);
  assert.equal(result.stdout, '');
});
