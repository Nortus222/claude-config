import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const validator = fileURLToPath(new URL('../infra/validate.ts', import.meta.url));
import { validateDeploymentParameters, parseDeploymentJson } from '../infra/validate.ts';
const image = `ghcr.io/nortus222/claude-config-service@sha256:${'a'.repeat(64)}`;
const valid = () => ({ location: 'eastus', namePrefix: 'ncc-hosted', githubClientId: 'Ov23_public', allowlistedLogins: ['Nortus222'], openSignup: false, budgetAmount: 10, budgetContactEmails: ['owner@example.com'], budgetStartDate: '2026-10-01', image });
test('public deployment inputs retain only canonical known values', () => { assert.deepEqual(validateDeploymentParameters(valid()), valid()); assert.deepEqual(validateDeploymentParameters({ ...valid(), allowlistedLogins: [] }).allowlistedLogins, []); });
test('public inputs fail closed on identity, image, shape and value violations', () => {
  for (const [key, value] of Object.entries({ image: 'ghcr.io/nortus222/claude-config-service:latest', location: '../eastus', namePrefix: 'UPPER', githubClientId: '', allowlistedLogins: ['a', 'A'], openSignup: 'false', budgetAmount: 0, budgetContactEmails: ['bad'], budgetStartDate: '2026-02-30', LOCAL_EMULATOR: true, AZURE_FEDERATED_TOKEN_FILE: '/token', nested: { value: 1 } })) assert.throws(() => validateDeploymentParameters({ ...valid(), [key]: value }), key);
  for (const bad of [image.replace('nortus222', 'foreign'), image.toUpperCase(), image + '\n']) assert.throws(() => validateDeploymentParameters({ ...valid(), image: bad }));
  for (const bad of [null, [], { ...valid(), budgetAmount: Infinity }, { ...valid(), budgetStartDate: '2026-10-02' }, { ...valid(), allowlistedLogins: Array(101).fill('a') }, { ...valid(), namePrefix: 'a'.repeat(21) }]) assert.throws(() => validateDeploymentParameters(bad));
});
test('CLI rejects duplicate keys, ARM nested fields and unconfigured example without reflecting values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-public-config-'));
  try {
    for (const contents of [JSON.stringify({ ...valid(), image: undefined }).replace('"eastus"', '"eastus","location":"westus"'), JSON.stringify({ parameters: { location: { value: 'eastus', secret: 'sensitive' } } }), '{}', readFileSync(new URL('../infra/parameters.example.json', import.meta.url), 'utf8')]) {
      const path = join(dir, 'input.json'); writeFileSync(path, contents);
      const result = spawnSync(process.execPath, [validator, path, image], { encoding: 'utf8' });
      assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'Invalid deployment configuration.\n');
    }
    const path = join(dir, 'input.json'); const { image: _, ...config } = valid(); writeFileSync(path, JSON.stringify(config));
    const result = spawnSync(process.execPath, [validator, path, image], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); const arm = JSON.parse(result.stdout); assert.deepEqual(arm.parameters.image, { value: image }); assert.equal(Object.keys(arm.parameters).length, 9);
  } finally { rmSync(dir, { recursive: true }); }
});
test('public strings, arrays and amounts reject hidden or invalid deployment values', () => {
  for (const patch of [{ githubClientId: 'client\n' }, { location: 'eastus\n' }, { namePrefix: 'bad--name' }, { budgetContactEmails: ['owner@example.com\n'] }, { allowlistedLogins: ['owner\n'] }, { budgetStartDate: '2026-10-01\n' }, { budgetAmount: 1.5 }, { allowlistedLogins: Array(1) }]) assert.throws(() => validateDeploymentParameters({ ...valid(), ...patch }));
});

test('bounded JSON rejects nested and escaped duplicate keys and oversized input', () => {
  for (const source of ['{"a":{"x":1,"x":2}}', '{"location":1,"\\u006cocation":2}', ' '.repeat(16385), '['.repeat(12) + '0' + ']'.repeat(12)]) assert.throws(() => parseDeploymentJson(source));
  assert.deepEqual(parseDeploymentJson('{"text":"quote \\" and brace }","nested":[1,true,null]}'), { text: 'quote " and brace }', nested: [1,true,null] });
});
test('CLI runs when import.meta.main is absent and imports without side effects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-validator-node-floor-'));
  try {
    const path = join(dir, 'input.json'); const { image: _, ...config } = valid(); writeFileSync(path, JSON.stringify(config));
    const loader = join(dir, 'compat.mjs');
    writeFileSync(loader, `import { registerHooks } from 'node:module'; registerHooks({load(url, context, nextLoad) { const loaded = nextLoad(url, context); return url.endsWith('/infra/validate.ts') ? {...loaded, source: 'delete import.meta.main;\\n' + loaded.source} : loaded; }});`);
    const result = spawnSync(process.execPath, ['--import', loader, validator, path, image], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).parameters.image, { value: image });
    const imported = spawnSync(process.execPath, ['--input-type=module', '--eval',  `await import(${JSON.stringify(new URL('../infra/validate.ts', import.meta.url).href)})`], { encoding: 'utf8' });
    assert.equal(imported.status, 0); assert.equal(imported.stdout, ''); assert.equal(imported.stderr, '');
  } finally { rmSync(dir, { recursive: true }); }
});
for (const [label, allowlistedLogins] of [
  ['comma-containing login', ['alice,bob']],
  ['one entry encoding 101 logins', [Array.from({ length: 101 }, (_, index) => `owner${index}`).join(',')]],
  ['empty login entry', ['']],
] as const) {
  test(`allowlist rejects ${label} before canonical deployment output`, () => {
    assert.throws(() => validateDeploymentParameters({ ...valid(), allowlistedLogins }));
  });
}
test('public configuration cannot request storage bootstrap', () => {
  assert.throws(() => validateDeploymentParameters({ ...valid(), bootstrapOnly: true }));
  assert.throws(() => validateDeploymentParameters({ ...valid(), bootstrapOnly: false }));
});
