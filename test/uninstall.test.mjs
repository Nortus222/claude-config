import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(REPO, 'bin', 'nortuscc.mjs');

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'nortuscc-uninstall-'));
  return {
    home,
    claude: join(home, '.claude'),
    codex: join(home, '.codex'),
    openrouter: join(home, '.codex-openrouter'),
    state: join(home, 'state'),
  };
}

async function runCli(args, env) {
  const childEnv = {
    ...process.env,
    NORTUSCC_CLAUDE_DIR: env.claude,
    NORTUSCC_CODEX_DIR: env.codex,
    NORTUSCC_STATE_DIR: env.state,
    NORTUSCC_REPO_DIR: REPO,
  };
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], { env: childEnv });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('uninstall removes configuration created on a fresh machine and stops managing it', async () => {
  const env = fixture();
  const applied = await runCli(['apply'], env);
  assert.equal(applied.code, 0, applied.stderr);

  const result = await runCli(['uninstall', '--yes'], env);
  assert.equal(result.code, 0, result.stderr);

  assert.equal(existsSync(join(env.claude, 'CLAUDE.md')), false);
  assert.equal(existsSync(join(env.claude, 'settings.json')), false);
  assert.equal(existsSync(join(env.codex, 'AGENTS.md')), false);
  assert.equal(existsSync(join(env.openrouter, 'config.toml')), false);
  assert.equal(existsSync(join(env.openrouter, 'models-static.json')), false);

  const state = JSON.parse(readFileSync(join(env.state, 'state.json'), 'utf8'));
  assert.equal(state.skillsOnly, true);
  assert.deepEqual(state.files, {});

  const reapplied = await runCli(['apply'], env);
  assert.equal(reapplied.code, 0, reapplied.stderr);
  assert.equal(existsSync(join(env.claude, 'CLAUDE.md')), false);
  assert.equal(existsSync(join(env.codex, 'AGENTS.md')), false);
});

test('uninstall restores pre-existing configuration without reverting unrelated settings', async () => {
  const env = fixture();
  mkdirSync(env.claude, { recursive: true });
  mkdirSync(env.codex, { recursive: true });
  mkdirSync(env.openrouter, { recursive: true });

  writeFileSync(join(env.claude, 'CLAUDE.md'), '# original claude instructions\n');
  writeFileSync(join(env.codex, 'AGENTS.md'), '# original codex instructions\n');
  writeFileSync(join(env.openrouter, 'config.toml'), 'model = "original"\n');
  writeFileSync(join(env.openrouter, 'models-static.json'), '{"original":true}\n');
  writeFileSync(
    join(env.claude, 'settings.json'),
    JSON.stringify({ theme: 'dark', attribution: { commit: 'original' }, mine: 'before setup' }, null, 2) + '\n',
  );

  const applied = await runCli(['apply'], env);
  assert.equal(applied.code, 0, applied.stderr);

  const afterApply = JSON.parse(readFileSync(join(env.claude, 'settings.json'), 'utf8'));
  afterApply.mine = 'changed after setup';
  writeFileSync(join(env.claude, 'settings.json'), JSON.stringify(afterApply, null, 2) + '\n');
  writeFileSync(
    join(env.openrouter, 'config.toml'),
    readFileSync(join(env.openrouter, 'config.toml'), 'utf8') +
      '\n[projects."/work/added-after-setup"]\ntrust_level = "trusted"\n',
  );

  const result = await runCli(['uninstall', '--yes'], env);
  assert.equal(result.code, 0, result.stderr);

  assert.equal(readFileSync(join(env.claude, 'CLAUDE.md'), 'utf8'), '# original claude instructions\n');
  assert.equal(readFileSync(join(env.codex, 'AGENTS.md'), 'utf8'), '# original codex instructions\n');
  assert.equal(
    readFileSync(join(env.openrouter, 'config.toml'), 'utf8'),
    'model = "original"\n\n[projects."/work/added-after-setup"]\ntrust_level = "trusted"\n',
  );
  assert.equal(readFileSync(join(env.openrouter, 'models-static.json'), 'utf8'), '{"original":true}\n');
  assert.deepEqual(
    JSON.parse(readFileSync(join(env.claude, 'settings.json'), 'utf8')),
    { theme: 'dark', attribution: { commit: 'original' }, mine: 'changed after setup' },
  );
});

test('uninstall refuses changed managed configuration unless forced', async () => {
  const env = fixture();
  const applied = await runCli(['apply'], env);
  assert.equal(applied.code, 0, applied.stderr);

  const claudePath = join(env.claude, 'CLAUDE.md');
  writeFileSync(claudePath, '# changed after setup\n');

  const refused = await runCli(['uninstall', '--yes'], env);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /changed.*nothing was uninstalled/);
  assert.equal(readFileSync(claudePath, 'utf8'), '# changed after setup\n');
  assert.ok(existsSync(join(env.codex, 'AGENTS.md')), 'refusal must happen before any other file changes');

  const forced = await runCli(['uninstall', '--yes', '--force'], env);
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(existsSync(claudePath), false);

  const backup = forced.stdout.match(/CLAUDE\.md\s+removed\s+backed up -> (.+)/)?.[1];
  assert.ok(backup, 'the forced uninstall must report where it preserved the changed file');
  assert.equal(readFileSync(backup, 'utf8'), '# changed after setup\n');

  const state = readFileSync(join(env.state, 'state.json'), 'utf8');
  assert.match(state, /"skillsOnly": true/);
});

test('uninstall rejects a narrow target without changing either agent', async () => {
  const env = fixture();
  const applied = await runCli(['apply'], env);
  assert.equal(applied.code, 0, applied.stderr);

  const result = await runCli(['uninstall', '--target', 'claude', '--yes'], env);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /whole machine/);
  assert.ok(existsSync(join(env.claude, 'CLAUDE.md')));
  assert.ok(existsSync(join(env.codex, 'AGENTS.md')));
});

test('uninstall restores a pre-existing empty settings file', async () => {
  const env = fixture();
  mkdirSync(env.claude, { recursive: true });
  writeFileSync(join(env.claude, 'settings.json'), '{}\n');

  const applied = await runCli(['apply'], env);
  assert.equal(applied.code, 0, applied.stderr);
  const result = await runCli(['uninstall', '--yes'], env);
  assert.equal(result.code, 0, result.stderr);

  assert.ok(existsSync(join(env.claude, 'settings.json')));
  assert.deepEqual(JSON.parse(readFileSync(join(env.claude, 'settings.json'), 'utf8')), {});
});

test('forced uninstall preserves malformed settings and completes', async () => {
  const env = fixture();
  const applied = await runCli(['apply'], env);
  assert.equal(applied.code, 0, applied.stderr);

  const settingsPath = join(env.claude, 'settings.json');
  writeFileSync(settingsPath, '{ malformed');

  const result = await runCli(['uninstall', '--yes', '--force'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(settingsPath), false);
  assert.equal(existsSync(join(env.codex, 'AGENTS.md')), false, 'the uninstall must finish every planned path');

  const backup = result.stdout.match(/settings\.json\s+removed\s+backed up -> (.+)/)?.[1];
  assert.ok(backup, 'the forced uninstall must report the malformed settings backup');
  assert.equal(readFileSync(backup, 'utf8'), '{ malformed');
});

test('a later uninstall does not mistake an earlier uninstall backup for an original', async () => {
  const env = fixture();
  assert.equal((await runCli(['apply'], env)).code, 0);
  assert.equal((await runCli(['uninstall', '--yes'], env)).code, 0);

  const reapplied = await runCli(['apply', '--no-skills-only'], env);
  assert.equal(reapplied.code, 0, reapplied.stderr);
  assert.ok(existsSync(join(env.claude, 'CLAUDE.md')));

  const result = await runCli(['uninstall', '--yes'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(env.claude, 'CLAUDE.md')), false);
  assert.equal(existsSync(join(env.claude, 'settings.json')), false);
  assert.equal(existsSync(join(env.codex, 'AGENTS.md')), false);
});

test('forced uninstall restores complete originals when managed files were deleted', async () => {
  const env = fixture();
  mkdirSync(env.claude, { recursive: true });
  mkdirSync(env.openrouter, { recursive: true });
  const settings = { theme: 'dark', mine: 'original' };
  const config = 'model = "original"\n\n[projects."/original"]\ntrust_level = "trusted"\n';
  writeFileSync(join(env.claude, 'settings.json'), JSON.stringify(settings) + '\n');
  writeFileSync(join(env.openrouter, 'config.toml'), config);

  assert.equal((await runCli(['apply'], env)).code, 0);
  rmSync(join(env.claude, 'settings.json'));
  rmSync(join(env.openrouter, 'config.toml'));

  const result = await runCli(['uninstall', '--yes', '--force'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(env.claude, 'settings.json'), 'utf8')), settings);
  assert.equal(readFileSync(join(env.openrouter, 'config.toml'), 'utf8'), config);
});

test('uninstall restores a pre-existing instruction-file symlink', {
  skip: process.platform === 'win32' ? 'creating symlinks may require elevation on Windows' : false,
}, async () => {
  const env = fixture();
  mkdirSync(env.claude, { recursive: true });
  writeFileSync(join(env.claude, 'mine.md'), '# mine\n');
  symlinkSync('mine.md', join(env.claude, 'CLAUDE.md'));

  assert.equal((await runCli(['apply'], env)).code, 0);
  const result = await runCli(['uninstall', '--yes'], env);
  assert.equal(result.code, 0, result.stderr);

  const restored = join(env.claude, 'CLAUDE.md');
  assert.ok(lstatSync(restored).isSymbolicLink());
  assert.equal(readlinkSync(restored), 'mine.md');
  assert.equal(readFileSync(restored, 'utf8'), '# mine\n');
});
