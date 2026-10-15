import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Effect, Layer } from 'effect';
import { machinePaths, nodeFs } from '../src/index.ts';
import { nodeProcessDialogue, ProcessDialogue } from '../src/process-dialogue.ts';
import { verifyClaudeSkill } from '../src/skills/claude-catalog.ts';

const posixTest = process.platform === 'win32' ? test.skip : test;
const command = { name: 'fixture-command', description: 'secret description (user)', argumentHint: '', aliases: ['fixture-folder'], future: true };
const rule = (rule: string, extra = {}) => ({ behavior: 'deny', source: 'userSettings', rule, editability: 'persistent', ...extra });
const fixture = (t: TestContext, mode = 'on', custom = false) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'claude-catalog-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const claude = join(home, custom ? 'custom-config' : '.claude'), cwd = join(home, 'neutral');
  const skillPath = join(claude, 'skills', 'fixture-folder', 'SKILL.md');
  mkdirSync(join(claude, 'skills', 'fixture-folder'), { recursive: true }); mkdirSync(cwd);
  const content = '---\nname: fixture-command\ndescription: fixture\n---\nfixture body\n';
  const settings = '{"custom":"preserve me","permissions":{"deny":["Skill(secret)"]}}';
  writeFileSync(skillPath, content); writeFileSync(join(claude, 'settings.json'), settings);
  const rows = mode === 'builtin-only' ? [{ ...command, builtin: true }] : mode === 'alias-only' ? [{ ...command, name: 'other-name', aliases: ['fixture-folder'] }]
    : ['off', 'user-only', 'frontmatter-disabled'].includes(mode) ? []
      : mode === 'duplicate' ? [command, command]
        : mode === 'alias-conflict' ? [command, { ...command, name: 'fixture-folder', aliases: [] }]
          : mode === 'builtin-conflict' ? [command, { ...command, builtin: true }] : [command];
  const userRows = mode === 'split-catalog' ? [{ ...command, name: 'fixture-folder', aliases: [] }] : ['off', 'model-only'].includes(mode) ? [] : rows.length ? rows : [command];
  const rules = mode === 'lowercase-rule' ? [rule('skill(*)')] : mode === 'exact-deny' ? [rule('Skill(fixture-command)')]
    : mode === 'folder-deny' ? [rule('Skill(fixture-folder)')]
      : mode === 'blanket-deny' ? [rule('Skill')]
        : mode === 'star-deny' ? [rule('Skill(*)')]
          : mode === 'ignored-deny' ? [rule('Skill', { notInEffect: true })]
            : mode === 'wildcard' ? [rule('Skill(fixture-*)')]
              : mode === 'ask' ? [rule('Skill(fixture-command)', { behavior: 'ask' })]
                : mode === 'other-rules' ? [rule('Skill(other)'), rule('Bash(*)'), rule('Skill(*)', { behavior: 'allow' })]
                  : mode === 'unknown-source' ? [rule('Skill(other)', { source: 'futureSource' })] : [];
  const state = { rules, workspaceDirectories: [], originalCwd: mode === 'wrong-permission-cwd' ? home : cwd, managedOnly: mode === 'ignored-deny' || mode === 'managed-only',
    ...(mode === 'parse-errors' ? { errors: [{ file: 'secret settings path', path: '', message: 'secret error' }] } : {}), future: true };
  const payloads: unknown[] = [{ commands: userRows, claude_code_version: 'fixture-version', future: true }, { skills: rows },
    mode === 'missing-permissions' ? {} : { state }];
  if (mode === 'malformed-catalog') payloads[1] = { skills: [{ ...command, aliases: [42] }] };
  if (mode === 'malformed-behavior') payloads[2] = { state: { ...state, rules: [rule('Skill(*)', { behavior: ['deny'] })] } };
  if (mode === 'malformed-permissions') payloads[2] = { state: { ...state, managedOnly: 'yes' } };
  const script = `const assert=require('node:assert/strict');let stage=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const x=JSON.parse(line);assert.equal(process.env.HOME,${JSON.stringify(home)});assert.equal(process.env.CLAUDE_CONFIG_DIR,${JSON.stringify(claude)});
assert.equal(x.type,'control_request');assert.deepEqual(x.request,{subtype:['initialize','reload_skills','list_permission_rules'][stage]});
if(${JSON.stringify(mode)}==='eof'){process.exit(0);return;}
if(${JSON.stringify(mode)}==='oversized'){console.log(JSON.stringify({type:'system',padding:'x'.repeat(1024*1024+1)}));return;}
if(${JSON.stringify(mode)}==='native-request'){console.log(JSON.stringify({type:'control_request',request_id:'server',request:{subtype:'can_use_tool'}}));return;}
console.log(JSON.stringify({type:'system',subtype:'fixture-notification'}));
console.log(JSON.stringify({type:'control_response',response:{subtype:(${JSON.stringify(mode)}==='unsupported-permissions'&&stage===2?'error':'success'),request_id:${mode === 'wrong-id' ? "'wrong'" : 'x.request_id'},response:${JSON.stringify(payloads)}[stage],error:'secret unsupported error',future:true}}));stage++;
});`;
  const local = Layer.effect(ProcessDialogue, ProcessDialogue.use(p => Effect.succeed({ exchange: (request: Parameters<typeof p.exchange>[0]) => {
    assert.equal(request.command.cmd, 'claude'); assert.equal(request.command.cwd, cwd);
    assert.deepEqual(request.command.args, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}']);
    return p.exchange({ ...request, command: { ...request.command, cmd: process.execPath, args: ['-e', script] } });
  } }))).pipe(Layer.provide(nodeProcessDialogue({ env: { HOME: home } })));
  const paths = { repo: home, claude, codex: home, codexOpenRouter: home, agentsSkills: home, stateRoot: home, backups: home };
  return { home, claude, cwd, skillPath, run: async (path = skillPath) => {
    const result = await Effect.runPromise(verifyClaudeSkill({ skillPath: path, installedName: 'fixture-folder', selectorName: 'fixture-command', cwd })
      .pipe(Effect.provide(Layer.mergeAll(nodeFs, machinePaths(paths), local))));
    assert.equal(readFileSync(skillPath, 'utf8'), content); assert.equal(readFileSync(join(claude, 'settings.json'), 'utf8'), settings);
    assert.doesNotMatch(JSON.stringify(result), /secret|fixture-version/);
    assert.deepEqual(result.limits, { selectedSource: 'not-attested', invocationAuthorization: 'not-attested', configRoot: 'requested-environment-only', managedStartup: 'remains-active' });
    return result;
  } };
};

for (const custom of [false, true]) posixTest(`Claude verifies model discovery in selected ${custom ? 'custom' : 'default'} root without authorization claims`, async t => {
  const f = fixture(t, 'on', custom); const result = await f.run();
  assert.equal(result.verified, true); assert.deepEqual(result.physical, { status: 'present', path: f.skillPath });
  assert.deepEqual(result.catalog, { status: 'present', userCommand: true });
  assert.equal(result.restrictions.status, 'no-known-denial');
});
posixTest('Claude canonicalizes physical symlinks separately from name-only native evidence', async t => {
  const f = fixture(t); const alias = join(f.home, 'alias'); symlinkSync(join(f.claude, 'skills', 'fixture-folder'), alias);
  assert.deepEqual((await f.run(join(alias, 'SKILL.md'))).physical, { status: 'present', path: f.skillPath });
});
for (const mode of ['model-only', 'alias-only', 'ignored-deny', 'other-rules', 'managed-only'])
  posixTest(`Claude accepts ${mode} catalog evidence with limits`, async t => { const result = await fixture(t, mode).run(); assert.equal(result.verified, true); if (mode === 'model-only') assert.equal(result.catalog.userCommand, false); });
for (const [mode, reason] of [['off', 'not-found'], ['user-only', 'not-found'], ['frontmatter-disabled', 'not-found'],
  ['duplicate', 'ambiguous'], ['alias-conflict', 'ambiguous'], ['builtin-conflict', 'ambiguous'], ['builtin-only', 'ambiguous'], ['split-catalog', 'ambiguous'],
  ['exact-deny', 'denied'], ['folder-deny', 'denied'], ['blanket-deny', 'denied'], ['star-deny', 'denied'],
  ['wildcard', 'unknown-restrictions'], ['lowercase-rule', 'unknown-restrictions'],
  ['wrong-permission-cwd', 'unsupported-permissions'], ['malformed-behavior', 'unsupported-permissions'], ['ask', 'unknown-restrictions'], ['unknown-source', 'unknown-restrictions'],
  ['parse-errors', 'settings-errors'], ['missing-permissions', 'unsupported-permissions'],
  ['malformed-catalog', 'invalid-catalog'], ['malformed-permissions', 'unsupported-permissions'],
  ['unsupported-permissions', 'unsupported'], ['wrong-id', 'invalid-response'], ['native-request', 'unexpected-request'],
  ['eof', 'unexpected-eof'], ['oversized', 'record-limit']] as const)
  posixTest(`Claude keeps ${mode} incomplete without raw diagnostics`, async t => {
    const result = await fixture(t, mode).run(); assert.equal(result.verified, false); assert.equal(result.reason, reason);
    if (reason === 'denied') assert.equal(result.restrictions.status, 'denied');
    if (mode === 'unsupported-permissions') assert.equal(result.catalog.status, 'present');
  });

posixTest('Claude refuses a noncanonical physical request before native discovery', async t => {
  const f = fixture(t); const result = await f.run('relative/SKILL.md');
  assert.equal(result.verified, false); assert.equal(result.reason, 'invalid-path');
  assert.deepEqual(result.physical, { status: 'unavailable' });
  assert.deepEqual(result.catalog, { status: 'unavailable' });
});

test('Claude returns the Windows process-tree prerequisite before launching', async t => {
  const f = fixture(t); const cp = await import('node:child_process'); const { syncBuiltinESMExports } = await import('node:module');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!; let launches = 0;
  t.mock.method(cp.default, 'spawn', () => { launches++; throw new Error('must not launch'); }); syncBuiltinESMExports();
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const result = await f.run(); assert.equal(result.verified, false); assert.equal(result.reason, 'unsupported-platform'); assert.equal(launches, 0);
  } finally { Object.defineProperty(process, 'platform', platform); t.mock.restoreAll(); syncBuiltinESMExports(); }
});
