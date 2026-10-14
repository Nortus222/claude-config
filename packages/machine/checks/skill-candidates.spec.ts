import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Effect, Layer } from 'effect';
import { Processes, machinePaths, nodeFs, nodeProcesses } from '../src/index.ts';
import { readSkillCandidates } from '../src/skills/candidates.ts';

const md = (name: string, extra = '') => `---\nname: ${name}\ndescription: A useful skill\n${extra}---\n# body\n`;
type Command = Parameters<Processes['Service']['run']>[0];
const fixture = (t: TestContext, files: Record<string, string>, intercept?: (command: Command, home: string) => Command) => {
  const home = mkdtempSync(join(tmpdir(), 'skill-candidates-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, 'source');
  mkdirSync(repo);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
  git(['init', '--quiet']);
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); }
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const revision = git(['rev-parse', 'HEAD']);
  const paths = { repo, claude: join(home, 'claude'), codex: join(home, 'codex'), codexOpenRouter: join(home, 'glm'), agentsSkills: join(home, 'skills'), stateRoot: join(home, 'state'), backups: join(home, 'backups') };
  const commands: Array<Parameters<Processes['Service']['run']>[0]> = [];
  const real = nodeProcesses({ env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const local = Layer.effect(Processes, Processes.use(p => Effect.succeed({ run: (command: Parameters<typeof p.run>[0]) => {
    commands.push(command);
    const localCommand = { ...command, args: command.args.map(a => a === 'https://github.com/fixture/source.git' ? pathToFileURL(repo).href : a) };
    return p.run(intercept?.(localCommand, home) ?? localCommand);
  } }))).pipe(Layer.provide(real));
  const run = (pin?: string) => Effect.runPromise(readSkillCandidates({ source: 'fixture/source', ...(pin ? { revision: pin } : {}) }).pipe(Effect.provide(Layer.mergeAll(machinePaths(paths), nodeFs, local))));
  return { run, git, revision, commands, paths };
};

test('binds metadata selector, canonical installed name, blob and tree to an accepted full commit', async t => {
  const f = fixture(t, { 'skills/layout-a/SKILL.md': md('Design Review', 'future: {anything: true}\n') });
  const result = await f.run(); assert.ok(result.ok);
  assert.equal(result.revision, f.revision);
  assert.deepEqual(result.candidates.map(c => [c.sourceDir, c.selectorName, c.installedName, c.description]), [['skills/layout-a', 'Design Review', 'design-review', 'A useful skill']]);
  const c = result.candidates[0]!;
  assert.equal(c.blob, f.git(['rev-parse', `${f.revision}:skills/layout-a/SKILL.md`]));
  assert.equal(c.tree, f.git(['rev-parse', `${f.revision}:skills/layout-a`]));
  assert.deepEqual(c.metadata.future, { anything: true });
  assert.ok(f.commands.every(c => c.output === 'capture' && c.stderr === 'capture' && c.captureLimit !== undefined));
  assert.deepEqual(readdirSync(join(f.paths.stateRoot, 'tmp')), []);
});

test('valid root dominates all other skills and root tree identity is retained', async t => {
  const f = fixture(t, { 'SKILL.md': md('root-skill'), 'skills/other/SKILL.md': md('other') });
  const r = await f.run(); assert.ok(r.ok); assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0]!.sourceDir, '.'); assert.equal(r.candidates[0]!.tree, f.git(['rev-parse', 'HEAD^{tree}']));
});

test('refuses known-container re-entry beneath a skill root', async t => {
  const f = fixture(t, { 'skills/SKILL.md': md('parent'), 'skills/.curated/child/SKILL.md': md('resource') });
  const r = await f.run(); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, 'unsupported-layout');
});

test('known containers have depth three; unrelated hidden candidates are refused explicitly', async t => {
  const f = fixture(t, { 'skills/a/b/deep/SKILL.md': md('deep'), 'examples/hidden/SKILL.md': md('hidden') });
  const r = await f.run(); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, 'unsupported-layout');
});

test('recursive fallback accepts unambiguous supported paths when there are no priority skills', async t => {
  const f = fixture(t, { 'examples/fallback/SKILL.md': md('fallback') });
  const r = await f.run(); assert.ok(r.ok); assert.equal(r.candidates[0]!.sourceDir, 'examples/fallback');
});

test('pin reads accepted old content after the source head moves', async t => {
  const f = fixture(t, { 'skills/first/SKILL.md': md('first') });
  writeFileSync(join(f.paths.repo, 'skills/first/SKILL.md'), md('second'));
  f.git(['add', '.']); f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'moved']);
  const r = await f.run(f.revision); assert.ok(r.ok); assert.equal(r.revision, f.revision); assert.equal(r.candidates[0]!.installedName, 'first');
});

for (const [label, text] of Object.entries({
  missing: '---\nname: absent\n---\n', malformed: '---\nname: [broken\ndescription: text\n---\n',
  number: '---\nname: 12\ndescription: text\n---\n', empty: md('"  "'),
  tag: md('!!js/function function(){}'), duplicateKey: md('safe', 'name: other\n'),
  internalClaim: md('safe', 'metadata: {internal: "true"}\n'),
  control: md('"unsafe\\u001b[31m"'), option: md('"--help"'), oversizedName: md('x'.repeat(256)),
  wildcard: md('"*"'), dot: md('".."'), boolean: md('true'),
  aliasBomb: '---\nname: safe\ndescription: text\na: &a [1, 2]\nb: [*a, *a]\n---\n',
})) {
  test(`refuses ${label} metadata with constant diagnostics and cleans its temporary source`, async t => {
    const f = fixture(t, { 'skills/a/SKILL.md': text }); const r = await f.run();
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, 'unsupported-metadata');
    assert.deepEqual(readdirSync(join(f.paths.stateRoot, 'tmp')), []);
    assert.ok(!JSON.stringify(r).includes('broken'));
  });
}
for (const names of [['Same', 'same'], ['a b', 'a-b']]) {
  test(`refuses ambiguous native names ${names.join('/')}`, async t => {
    const f = fixture(t, { 'skills/a/SKILL.md': md(names[0]!), 'skills/b/SKILL.md': md(names[1]!) });
    const r = await f.run(); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, 'ambiguous-selection');
  });
}

test('retains explicit internal metadata because native explicit selection includes it', async t => {
  const f = fixture(t, { 'skills/a/SKILL.md': md('internal-skill', 'metadata: {internal: true, future: other}\n') });
  const r = await f.run(); assert.ok(r.ok); assert.equal(r.candidates[0]!.internal, true);
});
for (const path of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'skills-lock.json']) {
  test(`refuses discovery-affecting ${path} layouts`, async t => {
    const f = fixture(t, { 'skills/a/SKILL.md': md('safe'), [path]: '{}' });
    const r = await f.run(); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, 'unsupported-layout');
  });
}

test('refuses oversized metadata before retaining it', async t => {
  const f = fixture(t, { 'skills/a/SKILL.md': md('safe') + 'x'.repeat(128 * 1024) });
  const r = await f.run(); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, 'limit-exceeded');
});

test('refuses more than 256 candidates', async t => {
  const f = fixture(t, Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`skills/a${i}/SKILL.md`, md(`a${i}`)])));
  const r = await f.run(); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, 'limit-exceeded');
});

const commit = (f: ReturnType<typeof fixture>) => { f.git(['add', '.']); f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'updated fixture']); };

test('accepts native YAML scalars, quoted names, BOM and folded descriptions', async t => {
  const f = fixture(t, { 'skills/a/SKILL.md': '\uFEFF---\r\nname: "true"\r\ndescription: >-\r\n  first line\r\n  second line\r\nfuture-date: 2026-10-14\r\n---\r\n' });
  const r = await f.run(); assert.ok(r.ok); assert.equal(r.candidates[0]!.selectorName, 'true');
  assert.equal(r.candidates[0]!.description, 'first line second line');
  assert.equal(r.candidates[0]!.metadata['future-date'], '2026-10-14');
});

test('a dominant root bypasses plugin and local-lock selection effects', async t => {
  const f = fixture(t, { 'SKILL.md': md('root'), '.claude-plugin/plugin.json': '{}', 'skills-lock.json': '{}' });
  const r = await f.run(); assert.ok(r.ok); assert.equal(r.candidates[0]!.sourceDir, '.');
});

test('regular nested SKILL resources are copied with the accepted tree but not selected', async t => {
  const f = fixture(t, { 'skills/a/SKILL.md': md('parent'), 'skills/a/resources/SKILL.md': 'not selectable metadata' });
  const r = await f.run(); assert.ok(r.ok); assert.equal(r.candidates.length, 1);
});

for (const kind of ['symlink', 'gitlink'] as const) {
  test(`refuses a candidate containing a ${kind} before installer content verification`, { skip: kind === 'symlink' && process.platform === 'win32' }, async t => {
    const f = fixture(t, { 'skills/a/SKILL.md': md('parent'), 'skills/a/plain.txt': 'inert' });
    if (kind === 'symlink') { symlinkSync('plain.txt', join(f.paths.repo, 'skills/a/linked')); commit(f); }
    else { f.git(['update-index', '--add', '--cacheinfo', `160000,${f.revision},skills/a/submodule`]); f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'submodule fixture']); }
    const r = await f.run(); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, 'unsupported-layout');
  });
}

test('refuses fallback roots with nested selectable skills', async t => {
  const f = fixture(t, { 'examples/a/SKILL.md': md('parent'), 'examples/a/nested/SKILL.md': md('nested') });
  const r = await f.run(); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, 'unsupported-layout');
});

test('bounds aggregate SKILL data at 8 MiB', async t => {
  const f = fixture(t, Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`skills/a${i}/SKILL.md`, md(`a${i}`) + 'x'.repeat(125 * 1024)])));
  const r = await f.run(); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, 'limit-exceeded');
  assert.deepEqual(readdirSync(join(f.paths.stateRoot, 'tmp')), []);
});

test('bounds Git tree capture at 2 MiB through a real child and cleans the source', async t => {
  const f = fixture(t, { 'skills/a/SKILL.md': md('safe') }, command => command.args[0] === 'ls-tree'
    ? { ...command, cmd: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024 + 1)); setInterval(() => {}, 1000);'] }
    : command);
  const r = await f.run(); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, 'limit-exceeded');
  assert.deepEqual(readdirSync(join(f.paths.stateRoot, 'tmp')), []);
});

test('the whole source read has a 30-second deadline and joins its child before temporary cleanup', { timeout: 35000 }, async t => {
  let marker = '';
  const f = fixture(t, { 'skills/a/SKILL.md': md('safe') }, (command, home) => {
    if (command.args[0] !== 'ls-tree') return command;
    marker = join(home, 'pid');
    return { ...command, cmd: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`] };
  });
  const started = Date.now(); const r = await f.run();
  assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, 'timed-out');
  assert.ok(Date.now() - started >= 29_000 && Date.now() - started < 34_000);
  assert.throws(() => process.kill(Number(readFileSync(marker, 'utf8')), 0), { code: 'ESRCH' });
  assert.deepEqual(readdirSync(join(f.paths.stateRoot, 'tmp')), []);
});

test('unreferenced nested plugin manifests do not change root discovery', async t => {
  const f = fixture(t, { 'skills/a/SKILL.md': md('safe'), 'docs/plugin/.claude-plugin/plugin.json': '{}' });
  const r = await f.run(); assert.ok(r.ok); assert.equal(r.candidates[0]!.installedName, 'safe');
});

test('refuses a symlinked priority container that could change native discovery', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t, { 'content/a/SKILL.md': md('safe') });
  symlinkSync('content', join(f.paths.repo, 'skills')); commit(f);
  const r = await f.run(); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, 'unsupported-layout');
});
