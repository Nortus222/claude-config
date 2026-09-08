import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run as apply } from '../src/commands/apply.mjs';
import { capturedPaths, run as capture } from '../src/commands/capture.mjs';

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
      ['meta/muse-spark-1.3-contributor', 'z-ai/glm-5.3-flash'].sort(),
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
