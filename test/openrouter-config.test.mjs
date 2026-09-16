import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { run as apply } from '../src/commands/apply.mjs';
import { capturedPaths, run as capture } from '../src/commands/capture.mjs';
import { configReport } from '../src/commands/status.mjs';
import { configSection } from '../src/install-sections.mjs';
import { SYNC } from '../src/manifest.mjs';
import { repoRoot } from '../src/resolve.mjs';
import { backupPath } from '../src/backup.mjs';
import { hashText, readLock, setBaseline, writeLock } from '../src/lock.mjs';

const EXPECTED = `model = "z-ai/glm-5.3-flash"
model_provider = "openrouter"
model_catalog_json = "models-static.json"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
wire_api = "responses"

[model_providers.openrouter.auth]
command = "node"
args = ["-e", "process.stdout.write(process.env.OPENROUTER_API_KEY || '')"]
`;

async function onMachine(fn) {
  const home = mkdtempSync(join(tmpdir(), 'nortuscc-openrouter-'));
  const saved = {
    codex: process.env.NORTUSCC_CODEX_DIR,
    openrouter: process.env.NORTUSCC_OPENROUTER_CODEX_DIR,
    state: process.env.NORTUSCC_STATE_DIR,
  };
  process.env.NORTUSCC_CODEX_DIR = join(home, '.codex');
  process.env.NORTUSCC_OPENROUTER_CODEX_DIR = join(home, '.codex-openrouter');
  process.env.NORTUSCC_STATE_DIR = join(home, 'state');
  mkdirSync(process.env.NORTUSCC_CODEX_DIR, { recursive: true });

  try {
    await fn({
      config: join(process.env.NORTUSCC_OPENROUTER_CODEX_DIR, 'config.toml'),
      catalog: join(process.env.NORTUSCC_OPENROUTER_CODEX_DIR, 'models-static.json'),
      source: join(home, 'source.toml'),
    });
  } finally {
    for (const [name, value] of Object.entries({
      NORTUSCC_CODEX_DIR: saved.codex,
      NORTUSCC_OPENROUTER_CODEX_DIR: saved.openrouter,
      NORTUSCC_STATE_DIR: saved.state,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test('apply --target codex installs the restricted OpenRouter Codex home without a secret', async () => {
  await onMachine(async ({ config, catalog }) => {
    assert.equal(await apply(['--target', 'codex']), 0);
    assert.equal(readFileSync(config, 'utf8'), EXPECTED);
    assert.doesNotMatch(readFileSync(config, 'utf8'), /sk-or-/);
    const models = JSON.parse(readFileSync(catalog, 'utf8')).models;
    assert.deepEqual(
      models.map(({ slug }) => slug).sort(),
      ['meta/muse-spark-1.3-contributor', 'stealth/union-alpha', 'z-ai/glm-5.3-flash'].sort(),
    );
    assert.ok(models.every(({ base_instructions: instructions }) => instructions.length > 0));
    assert.ok(models.every(({ supports_parallel_tool_calls: supported }) => supported === true));
  });
});

test('skills-only skips the OpenRouter configuration', async () => {
  await onMachine(async ({ config, catalog }) => {
    assert.equal(await apply(['--target', 'codex', '--skills-only']), 0);
    assert.equal(existsSync(config), false);
    assert.equal(existsSync(catalog), false);
  });
});

test('local project trust does not cause config drift or an install selection', async () => {
  await onMachine(async ({ config }) => {
    assert.equal(await apply(['--target', 'codex']), 0);
    const local = `${EXPECTED}\n[projects."/work/example"]\ntrust_level = "trusted"\n`;
    writeFileSync(config, local);
    assert.equal(configReport().find(row => row.dest === 'config.toml').state, 'clean');
    assert.equal(configSection('codex').items().find(item => item.label === 'config.toml').state, 'installed');
    assert.equal(await apply(['--target', 'codex']), 0);
    assert.equal(readFileSync(config, 'utf8'), local);
  });
});

test('apply updates managed settings while preserving project tables and the full backup', async () => {
  await onMachine(async ({ config, source }) => {
    const entries = [{ ...SYNC.find(entry => entry.dest === 'config.toml'), src: relative(repoRoot(), source) }];
    writeFileSync(source, EXPECTED);
    assert.equal(await apply(['--target', 'codex'], entries), 0);
    const projects = `[projects.'/work/one'] # local trust\ntrust_level = 'trusted'\n\n["projects"."/work/two"]\ntrust_level = "untrusted"\n`;
    const local = EXPECTED.replace('[model_providers.openrouter]', `${projects}\n[model_providers.openrouter]`);
    writeFileSync(config, local);
    const updated = EXPECTED.replace('z-ai/glm-5.3-flash', 'next-model');
    writeFileSync(source, updated);
    assert.equal(configReport(entries)[0].state, 'repo-ahead');
    assert.equal(await apply(['--target', 'codex'], entries), 0);
    assert.equal(readFileSync(backupPath('config.toml', 'codex'), 'utf8'), local);
    const result = readFileSync(config, 'utf8');
    assert.ok(result.startsWith(updated));
    assert.ok(result.includes(projects));
    assert.equal(configReport(entries)[0].state, 'clean');
    assert.equal(await apply(['--target', 'codex'], entries), 0);
    assert.equal(readFileSync(config, 'utf8'), result);
  });
});

test('managed edits still conflict and take-repo preserves local trust', async () => {
  await onMachine(async ({ config, source }) => {
    const entries = [{ ...SYNC.find(entry => entry.dest === 'config.toml'), src: relative(repoRoot(), source) }];
    writeFileSync(source, EXPECTED);
    assert.equal(await apply(['--target', 'codex'], entries), 0);
    const projects = '\n[projects."/work/example"]\ntrust_level = "trusted"\n';
    const local = EXPECTED.replace('z-ai/glm-5.3-flash', 'local-model') + projects;
    writeFileSync(config, local);
    assert.equal(configReport(entries)[0].state, 'local-ahead');
    writeFileSync(source, EXPECTED.replace('z-ai/glm-5.3-flash', 'repo-model'));
    assert.equal(configReport(entries)[0].state, 'conflict');
    assert.equal(await apply(['--target', 'codex'], entries), 1);
    assert.equal(readFileSync(config, 'utf8'), local);
    assert.equal(await apply(['--target', 'codex', '--take-repo'], entries), 0);
    assert.equal(readFileSync(config, 'utf8'), readFileSync(source, 'utf8') + projects);
    assert.equal(configReport(entries)[0].state, 'clean');
  });
});

test('project-like headers inside multiline strings remain managed', async () => {
  await onMachine(async ({ config, source }) => {
    const entries = [{ ...SYNC.find(entry => entry.dest === 'config.toml'), src: relative(repoRoot(), source) }];
    for (const delimiter of ['"""', "'''"]) {
      const repo = `instructions = ${delimiter}\n[projects."example"]\noriginal text\n${delimiter}\n` + EXPECTED;
      writeFileSync(source, repo);
      assert.equal(await apply(['--target', 'codex', '--take-repo'], entries), 0);
      writeFileSync(config, repo.replace('original text', 'local text'));
      assert.equal(configReport(entries)[0].state, 'local-ahead');
    }
  });
});

test('legacy whole-file baselines converge without rewriting local project tables', async () => {
  await onMachine(async ({ config }) => {
    assert.equal(await apply(['--target', 'codex']), 0);
    const local = `${EXPECTED}\n[projects."/work/example"]\ntrust_level = "trusted"\n`;
    writeFileSync(config, local);
    const lock = readLock();
    setBaseline(lock, 'codex:config.toml', hashText('old whole-file content'));
    writeLock(lock);
    assert.equal(configReport().find(row => row.dest === 'config.toml').state, 'clean');
    assert.equal(await apply(['--target', 'codex']), 0);
    assert.equal(readFileSync(config, 'utf8'), local);
    assert.equal(readLock().files['codex:config.toml'].hash, hashText(EXPECTED));
  });
});

test('array values resembling project headers remain managed', async () => {
  await onMachine(async ({ config, source }) => {
    const entries = [{ ...SYNC.find(entry => entry.dest === 'config.toml'), src: relative(repoRoot(), source) }];
    const repo = 'values = [\n ["projects"],\n ["original"]\n]\n' + EXPECTED;
    writeFileSync(source, repo);
    assert.equal(await apply(['--target', 'codex'], entries), 0);
    assert.equal(readFileSync(config, 'utf8'), repo);
    writeFileSync(config, repo.replace('original', 'local'));
    assert.equal(configReport(entries)[0].state, 'local-ahead');
  });
});

test('the install picker preserves project tables when replacing unmanaged config', async () => {
  await onMachine(async ({ config }) => {
    mkdirSync(process.env.NORTUSCC_OPENROUTER_CODEX_DIR, { recursive: true });
    const projects = '[projects]\n"/work/example" = { trust_level = "trusted" }\n';
    writeFileSync(config, 'model = "old-model"\n\n' + projects);
    const section = configSection('codex');
    const item = section.items().find(item => item.label === 'config.toml');
    assert.equal(item.state, 'missing');
    assert.equal((await section.install([item]))[0].ok, true);
    assert.equal(readFileSync(config, 'utf8'), EXPECTED + '\n' + projects);
    assert.equal(section.items().find(item => item.label === 'config.toml').state, 'installed');
  });
});

test('--with-config installs OpenRouter configuration for a skills-only machine without changing its mode', async () => {
  await onMachine(async ({ config, catalog }) => {
    assert.equal(await apply(['--target', 'codex', '--skills-only']), 0);
    assert.equal(await apply(['--target', 'codex', '--with-config']), 0);
    assert.equal(readFileSync(config, 'utf8'), EXPECTED);
    assert.equal(existsSync(catalog), true);
  });
});

test('capture never publishes local OpenRouter configuration edits', async () => {
  await onMachine(async ({ config }) => {
    const repo = mkdtempSync(join(tmpdir(), 'nortuscc-openrouter-repo-'));
    const source = join(repo, 'config.toml');
    mkdirSync(process.env.NORTUSCC_OPENROUTER_CODEX_DIR, { recursive: true });
    writeFileSync(source, EXPECTED);
    writeFileSync(config, `${EXPECTED}\napi_key = "sk-or-secret"\n`);

    try {
      const entries = [{
        target: 'codex',
        machine: 'codex-openrouter',
        src: source,
        dest: 'config.toml',
        mode: 'copy',
        capture: false,
      }];
      assert.equal(await capture(['--target', 'codex', '--take-local'], entries), 0);
      assert.equal(readFileSync(source, 'utf8'), EXPECTED);
      assert.ok(!capturedPaths().includes(source));
      assert.ok(!capturedPaths().includes('codex/openrouter-glm/config.toml'));
      assert.ok(!capturedPaths().includes('codex/openrouter-glm/models-static.json'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
