import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePreflight, deploy, validateAzureInputs } from '../infra/deploy.ts';
import { validateDeploymentParameters } from '../infra/validate.ts';
const subscription = '11111111-1111-4111-8111-111111111111';
const ci = '22222222-2222-4222-8222-222222222222';
const tenant = '33333333-3333-4333-8333-333333333333';
const ids = { subscription, client: ci, tenant, group: 'hosted-service' };
const params = validateDeploymentParameters({ location: 'eastus', namePrefix: 'nortuscc', githubClientId: 'Iv1_validclient', allowlistedLogins: [], openSignup: false, budgetAmount: 10, budgetContactEmails: ['owner@example.com'], budgetStartDate: '2026-10-01', image: `ghcr.io/nortus222/claude-config-service@sha256:${'a'.repeat(64)}` });
const rg = `/subscriptions/${subscription}/resourceGroups/${ids.group}`;
const accountId = `${rg}/providers/Microsoft.DocumentDB/databaseAccounts/nortuscc-unique123`;
const providers = ['Microsoft.App', 'Microsoft.DocumentDB', 'Microsoft.ManagedIdentity', 'Microsoft.OperationalInsights', 'Microsoft.Insights', 'Microsoft.Consumption'];
const snapshot = () => ({ subscription: { id: subscription, tenantId: tenant, state: 'Enabled' }, group: { id: rg }, providers: providers.map(namespace => ({ namespace, registrationState: 'Registered', resourceTypes: [{ resourceType: namespace === 'Microsoft.App' ? 'managedEnvironments' : namespace === 'Microsoft.DocumentDB' ? 'databaseAccounts' : namespace === 'Microsoft.ManagedIdentity' ? 'userAssignedIdentities' : namespace === 'Microsoft.OperationalInsights' ? 'workspaces' : 'ignored', locations: ['East US'] }] })), accounts: [], deployments: [], identities: [], resources: [], budgets: [] });
const existing = () => ({ id: accountId, name: 'nortuscc-unique123', location: 'eastus', properties: { consistencyPolicy: { defaultConsistencyLevel: 'Strong' }, enableFreeTier: true, disableLocalAuth: true, enableMultipleWriteLocations: false, enableAutomaticFailover: false, capacity: { totalThroughputLimit: 1000 }, locations: [{ locationName: 'East US', failoverPriority: 0 }], backupPolicy: { type: 'Periodic', periodicModeProperties: { backupIntervalInMinutes: 240, backupRetentionIntervalInHours: 8 } } } });
test('public CI UUIDs are mandatory and reject argument/shell/newline inputs', () => {
  assert.deepEqual(validateAzureInputs({ AZURE_CLIENT_ID: ci, AZURE_TENANT_ID: tenant, AZURE_SUBSCRIPTION_ID: subscription, AZURE_RESOURCE_GROUP: ids.group }), ids);
  for (const patch of [{ AZURE_CLIENT_ID: '' }, { AZURE_TENANT_ID: `${tenant}\n` }, { AZURE_RESOURCE_GROUP: '--help' }, { AZURE_RESOURCE_GROUP: '$(id)' }]) assert.throws(() => validateAzureInputs({ AZURE_CLIENT_ID: ci, AZURE_TENANT_ID: tenant, AZURE_SUBSCRIPTION_ID: subscription, AZURE_RESOURCE_GROUP: ids.group, ...patch }));
});
test('new-account preflight fails closed for subscription, providers, region, free tier and CI/runtime collision', () => {
  assert.equal(evaluatePreflight(snapshot(), ids, params), undefined);
  const cases = [ { ...snapshot(), subscription: { id: 'wrong', tenantId: tenant, state: 'Enabled' } }, { ...snapshot(), providers: [] }, { ...snapshot(), providers: snapshot().providers.map(p => ({ ...p, registrationState: 'NotRegistered' })) }, { ...snapshot(), providers: snapshot().providers.map(p => ({ ...p, resourceTypes: [] })) }, { ...snapshot(), accounts: [existing()] }, { ...snapshot(), identities: [{ name: 'nortuscc-runtime', clientId: ci }] }, { ...snapshot(), resources: [{ id: `${rg}/providers/Microsoft.Storage/storageAccounts/foreign`, type: 'Microsoft.Storage/storageAccounts', name: 'foreign' }] } ];
  for (const s of cases) assert.throws(() => evaluatePreflight(s, ids, params));
});
test('only the prior fixed deployment can own the sole free-tier account', () => {
  const s = { ...snapshot(), accounts: [existing()], deployments: [{ name: 'hosted-service', properties: { outputResources: [{ id: accountId }] } }] };
  assert.equal(evaluatePreflight(s, ids, params), accountId);
  for (const patch of [{ enableFreeTier: false }, { disableLocalAuth: false }, { consistencyPolicy: { defaultConsistencyLevel: 'Session' } }, { capacity: { totalThroughputLimit: -1 } }, { enableMultipleWriteLocations: true }]) assert.throws(() => evaluatePreflight({ ...s, accounts: [{ ...existing(), properties: { ...existing().properties, ...patch } }] }, ids, params));
  assert.throws(() => evaluatePreflight({ ...s, accounts: [existing(), { ...existing(), id: `${rg}/providers/Microsoft.DocumentDB/databaseAccounts/foreign` }] }, ids, params));
});
test('preflight failure invokes only read commands; successful deployment uses argument arrays and distinct output identity', async () => {
  const calls: string[][] = [];
  const runner = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'account') return snapshot().subscription;
    if (args[0] === 'group') return snapshot().group;
    if (args[0] === 'provider') return snapshot().providers.find(p => p.namespace === args[args.indexOf('--namespace') + 1]);
    if (args[0] === 'rest') return { value: [] };
    if (args[0] === 'identity' || args[0] === 'resource' || args[2] === 'list') return [];
    if (args[2] === 'create') return { properties: { outputs: { endpoint: { value: 'https://nortuscc.example.azurecontainerapps.io' }, appName: { value: 'nortuscc-service' }, runtimeIdentityResourceId: { value: `${rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/nortuscc-runtime` }, runtimeIdentityClientId: { value: '44444444-4444-4444-8444-444444444444' }, runtimeIdentityPrincipalId: { value: '55555555-5555-4555-8555-555555555555' } } } };
    throw new Error('unexpected command');
  };
  await assert.rejects(deploy(ids, params, '/tmp/validated.json', async args => args[0] === 'group' ? { id: 'foreign' } : runner(args)));
  assert.ok(calls.every(args => !args.includes('create') && !args.includes('register') && !args.includes('assign')));
  calls.length = 0;
  const result = await deploy(ids, params, '/tmp/validated.json', runner);
  assert.equal(result.appName, 'nortuscc-service');
  const mutations = calls.filter(args => args.includes('create')); assert.equal(mutations.length, 1);
  assert.ok(mutations[0]?.includes('Incremental')); assert.ok(mutations[0]?.includes('@/tmp/validated.json'));
  await assert.rejects(deploy(ids, params, '/tmp/validated.json', async args => {
    const result = await runner(args);
    if (args[2] === 'create') (result as any).properties.outputs.runtimeIdentityClientId.value = ci;
    return result;
  }));
});
test('truncated ARM account or budget inventory cannot authorize mutation', async () => {
  const calls: string[][] = [];
  await assert.rejects(deploy(ids, params, '/tmp/validated.json', async args => {
    calls.push([...args]);
    if (args[0] === 'account') return snapshot().subscription;
    if (args[0] === 'group') return snapshot().group;
    if (args[0] === 'provider') return snapshot().providers.find(p => p.namespace === args[args.indexOf('--namespace') + 1]);
    if (args[0] === 'rest') return { value: [], nextLink: 'https://management.azure.com/next' };
    return [];
  }));
  assert.ok(calls.every(args => !args.includes('create')));
});
test('existing owned database rejects autoscale, dedicated throughput, wrong TTL/keys and incomplete pages before mutation', async () => {
  const cases = ['throughput', 'autoscale', 'ttl', 'key', 'dedicated', 'database-page', 'container-page', 'budget', 'budget-page', 'account-page', 'identity', 'workspace', 'app'];
  for (const defect of cases) {
    const calls: string[][] = [];
    await assert.rejects(deploy(ids, params, '/tmp/validated.json', async args => {
      calls.push([...args]);
      if (args[0] === 'account') return snapshot().subscription;
      if (args[0] === 'group') return snapshot().group;
      if (args[0] === 'provider') return snapshot().providers.find(p => p.namespace === args[args.indexOf('--namespace') + 1]);
      if (args[0] === 'identity') return defect === 'identity' ? [{ name: 'nortuscc-runtime', clientId: ci }] : [];
      if (args[0] === 'resource') return defect === 'workspace' ? [{ id: `${rg}/providers/Microsoft.OperationalInsights/workspaces/nortuscc-logs`, name: 'nortuscc-logs', type: 'Microsoft.OperationalInsights/workspaces' }] : defect === 'app' ? [{ id: `${rg}/providers/Microsoft.App/containerApps/nortuscc-service`, name: 'nortuscc-service', type: 'Microsoft.App/containerApps' }] : [{ id: accountId, name: existing().name, type: 'Microsoft.DocumentDB/databaseAccounts' }];
      if (args[0] === 'deployment') {
        if (args[2] === 'list') return [{ name: 'hosted-service', properties: { outputResources: [{ id: accountId }] } }];
        throw new Error('Unexpected mutation');
      }
      const url = args[args.indexOf('--url') + 1] ?? '';
      if (url.includes('/workspaces/') || url.includes('/containerApps/')) return { location: 'eastus', properties: {} };
      if (url.includes('/budgets?')) return { value: defect === 'budget' ? [{ name: 'nortuscc-monthly', properties: { amount: 99, timeGrain: 'Monthly', category: 'Cost', timePeriod: { startDate: params.budgetStartDate } } }] : [], ...(defect === 'budget-page' ? { nextLink: 'next' } : {}) };
      if (url.includes('/throughputSettings/')) return { properties: { resource: defect === 'autoscale' ? { throughput: 1000, autoscaleSettings: { maxThroughput: 1000 } } : { throughput: defect === 'throughput' ? 400 : 1000 } } };
      if (url.includes('/containers?')) return { value: Object.entries({ accounts: '/accountId', setups: '/setupId', identities: '/id' }).map(([id, key]) => ({ properties: { resource: { id, partitionKey: { kind: 'Hash', paths: [defect === 'key' ? '/wrong' : key] }, defaultTtl: defect === 'ttl' ? null : -1 }, options: defect === 'dedicated' ? { throughput: 400 } : {} } })), ...(defect === 'container-page' ? { nextLink: 'next' } : {}) };
      if (url.includes('/sqlDatabases?')) return { value: [{ properties: { resource: { id: 'metadata' } } }], ...(defect === 'database-page' ? { nextLink: 'next' } : {}) };
      return { value: [existing()], ...(defect === 'account-page' ? { nextLink: 'next' } : {}) };
    }), defect);
    assert.ok(calls.every(args => !args.includes('create')), defect);
  }
});
