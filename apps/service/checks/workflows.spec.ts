import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const read = (name: string) => readFileSync(new URL(`../../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
test('delivery workflows are manual main-only with approval-isolated least privileges and immutable source', () => {
  for (const [file, job, environment, write] of [['service-image', 'publish', 'hosted-image', 'packages: write'], ['service-deploy', 'deploy', 'hosted-production', 'id-token: write']]) {
    const yaml = read(file!);
    const trigger = yaml.slice(yaml.indexOf('\non:'), yaml.indexOf('\npermissions:'));
    assert.match(trigger, /workflow_dispatch:/); assert.doesNotMatch(trigger, /(?:push|pull_request|workflow_call|workflow_run|schedule|release):/);
    assert.match(yaml, /\npermissions: \{\}/);
    assert.equal((yaml.match(/github\.ref == 'refs\/heads\/main'/g) ?? []).length, 2);
    assert.equal((yaml.match(/github\.repository == 'Nortus222\/claude-config'/g) ?? []).length, 2);
    const prepare = yaml.slice(yaml.indexOf('\n  prepare:'), yaml.indexOf(`\n  ${job}:`));
    assert.match(prepare, /contents: read/); assert.match(prepare, /actions: read/);
    assert.doesNotMatch(prepare, /packages: write|id-token: write|environment:|Azure\/login|docker\/login-action|push: true/);
    const approved = yaml.slice(yaml.indexOf(`\n  ${job}:`));
    assert.match(approved, /needs: prepare/); assert.ok(approved.includes(`environment: ${environment}`)); assert.ok(approved.includes(write!));
    assert.doesNotMatch(approved, file === 'service-image' ? /id-token: write|Azure\/login/ : /packages: write|docker\/login-action/);
    assert.equal((yaml.match(/persist-credentials: false/g) ?? []).length, 2); assert.equal((yaml.match(/ref: \$\{\{ github.sha \}\}/g) ?? []).length, 2);
    for (const line of yaml.split('\n').filter(l => /uses:/.test(l))) assert.match(line, /uses: [\w/-]+@[a-f0-9]{40} # v[\d.]+$/);
    for (const run of yaml.matchAll(/run: \|\n((?: {10}.*\n)+)/g)) assert.doesNotMatch(run[1]!, /\$\{\{/);
    assert.ok(yaml.includes('REVIEWED_COMMIT: ${{ inputs.reviewed_commit }}'));
  }
});
test('deployer validates anonymously before login and exposes no runtime federation or mutable path', () => {
  const yaml = read('service-deploy');
  assert.ok(yaml.indexOf('node apps/service/infra/release.ts deploy') < yaml.indexOf('Azure/login@'));
  assert.match(yaml, /node apps\/service\/infra\/deploy.ts inputs/);
  assert.match(yaml, /node apps\/service\/infra\/deploy.ts execute/);
  assert.match(yaml, /IMAGE_REF: \$\{\{ inputs.image_ref \}\}/);
  for (const key of ['CLIENT_ID', 'TENANT_ID', 'SUBSCRIPTION_ID', 'RESOURCE_GROUP']) assert.ok(yaml.includes(`AZURE_${key}: $`));
  assert.doesNotMatch(yaml, /client-secret|creds:|AZURE_FEDERATED_TOKEN_FILE|parameter_file:/);
});
test('ordinary validation never receives publishing/deployment credentials and actually tests image', () => {
  const yaml = read('service-validation');
  assert.match(yaml, /pull_request:/); assert.match(yaml, /contents: read/);
  assert.doesNotMatch(yaml, /packages: write|id-token: write|environment:|push: true|Azure\/login|docker\/login-action/);
  assert.match(yaml, /bicep install --version v0\.47\.16/);
  const cosmos = read('cosmos');
  assert.match(cosmos, /docker build --platform linux\/amd64/);
  assert.match(cosmos, /NORTUSCC_SERVICE_IMAGE_EMULATOR_CONTAINER: nortuscc-cosmos-ci/);
  assert.match(cosmos, /NORTUSCC_SERVICE_IMAGE_ORIGIN: http:\/\/127\.0\.0\.1:8090/);
  assert.match(cosmos, /--publish 127\.0\.0\.1:8090:8090/);
  assert.match(cosmos, /npm run test:image -w apps\/service/);
});
