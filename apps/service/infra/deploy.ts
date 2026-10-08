import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, rm, realpath, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeploymentParameters } from './validate.ts';
import { checkContext, checkImageCommit, loadParameters, record, verifyEnvironment, verifyPublicImage } from './release.ts';

function fail(): never { throw new Error('Deployment preflight failed.'); }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export type AzureInputs = { client: string; tenant: string; subscription: string; group: string };
export type Runner = (args: readonly string[]) => Promise<unknown>;
export function validateAzureInputs(env: NodeJS.ProcessEnv): AzureInputs {
  const client = env.AZURE_CLIENT_ID ?? ''; const tenant = env.AZURE_TENANT_ID ?? ''; const subscription = env.AZURE_SUBSCRIPTION_ID ?? ''; const group = env.AZURE_RESOURCE_GROUP ?? '';
  if (![client, tenant, subscription].every(id => id.length === 36 && uuid.test(id)) || /[\s\x00-\x1f\x7f]/.test(group) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,89}$/.test(group)) fail();
  return { client, tenant, subscription, group };
}
const requiredProviders = ['Microsoft.App', 'Microsoft.DocumentDB', 'Microsoft.ManagedIdentity', 'Microsoft.OperationalInsights', 'Microsoft.Insights', 'Microsoft.Consumption'];
const regionalTypes: Record<string, string> = { 'Microsoft.App': 'managedEnvironments', 'Microsoft.DocumentDB': 'databaseAccounts', 'Microsoft.ManagedIdentity': 'userAssignedIdentities', 'Microsoft.OperationalInsights': 'workspaces' };
const list = (value: unknown): Record<string, unknown>[] => { if (!Array.isArray(value)) return fail(); return value.map(record); };
const region = (value: unknown) => typeof value === 'string' ? value.replaceAll(' ', '').toLowerCase() : '';
const sameId = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const resourceGroupId = (ids: AzureInputs) => `/subscriptions/${ids.subscription}/resourceGroups/${ids.group}`;
export type Snapshot = { subscription: unknown; group: unknown; providers: unknown; accounts: unknown; deployments: unknown; identities: unknown; resources: unknown; budgets: unknown };
/** No account is adopted: existing ownership comes from the prior fixed deployment. */
export function evaluatePreflight(snapshot: Snapshot, ids: AzureInputs, params: DeploymentParameters, bootstrapVerification = false): string | undefined {
  const subscription = record(snapshot.subscription); const rg = resourceGroupId(ids);
  if (!sameId(subscription.id, ids.subscription) || !sameId(subscription.tenantId, ids.tenant) || subscription.state !== 'Enabled' || !sameId(record(snapshot.group).id, rg)) fail();
  const providers = list(snapshot.providers);
  for (const namespace of requiredProviders) {
    const provider = providers.find(p => p.namespace === namespace);
    if (!provider || provider.registrationState !== 'Registered') fail();
    if (regionalTypes[namespace]) {
      const type = list(provider.resourceTypes).find(t => t.resourceType === regionalTypes[namespace]);
      if (!type || !Array.isArray(type.locations) || !type.locations.some(location => region(location) === params.location)) fail();
    }
  }
  const identities = list(snapshot.identities);
  for (const identity of identities) if (sameId(identity.clientId ?? record(identity.properties).clientId, ids.client)) fail();
  const previous = list(snapshot.deployments).find(d => d.name === 'hosted-service');
  const outputs = previous ? list(record(previous.properties).outputResources) : [];
  const ownedAccounts = outputs.filter(o => typeof o.id === 'string' && o.id.toLowerCase().startsWith(`${rg}/providers/Microsoft.DocumentDB/databaseAccounts/`.toLowerCase()) && o.id.split('/').length === 9);
  if (ownedAccounts.length > 1) fail();
  const expected = ownedAccounts[0]?.id;
  if (expected !== undefined && (typeof expected !== 'string' || !expected.toLowerCase().startsWith(`${rg}/providers/Microsoft.DocumentDB/databaseAccounts/${params.namePrefix}-`.toLowerCase()))) fail();
  // A failed deployment with runtime leftovers is recovery, not a new-account bootstrap.
  if (!expected && (identities.length !== 0 || list(snapshot.budgets).length !== 0 || list(snapshot.resources).some(resource => String(resource.type).toLowerCase() !== 'microsoft.resources/deployments'))) fail();
  const accounts = list(snapshot.accounts);
  const free = accounts.filter(a => record(a.properties).enableFreeTier === true);
  const account = expected ? accounts.find(a => sameId(a.id, String(expected))) : undefined;
  if (expected && !account) fail();
  if (free.length !== (account ? 1 : 0) || (account && !sameId(free[0]?.id, String(expected)))) fail();
  for (const resource of list(snapshot.resources)) {
    const type = String(resource.type).toLowerCase();
    const names: Record<string, string> = { 'microsoft.managedidentity/userassignedidentities': `${params.namePrefix}-runtime`, 'microsoft.app/managedenvironments': `${params.namePrefix}-environment`, 'microsoft.app/containerapps': `${params.namePrefix}-service`, 'microsoft.operationalinsights/workspaces': `${params.namePrefix}-logs`, 'microsoft.consumption/budgets': `${params.namePrefix}-monthly` };
    if (type === 'microsoft.resources/deployments') {
      if (resource.name !== 'hosted-service') fail();
      continue;
    }
    if (type === 'microsoft.insights/diagnosticsettings') {
      if (!sameId(resource.id, `${rg}/providers/Microsoft.App/managedEnvironments/${params.namePrefix}-environment/providers/Microsoft.Insights/diagnosticSettings/${params.namePrefix}-logs`) || !previous) fail();
      continue;
    }
    if (type.startsWith('microsoft.documentdb/databaseaccounts/')) {
      if (!expected || typeof resource.id !== 'string' || !resource.id.toLowerCase().startsWith(`${expected}/`.toLowerCase()) || !outputs.some(o => sameId(o.id, String(resource.id))) && ![`${expected}/sqlDatabases/metadata`, ...['accounts', 'setups', 'identities'].map(name => `${expected}/sqlDatabases/metadata/containers/${name}`)].some(id => sameId(resource.id, id)) || !['microsoft.documentdb/databaseaccounts/sqldatabases', 'microsoft.documentdb/databaseaccounts/sqldatabases/containers', 'microsoft.documentdb/databaseaccounts/sqlroledefinitions', 'microsoft.documentdb/databaseaccounts/sqlroleassignments'].includes(type)) fail();
      continue;
    }
    if (type === 'microsoft.documentdb/databaseaccounts' ? !expected || !sameId(resource.id, String(expected)) : (!names[type] || resource.name !== names[type])) fail();
    if (!previous || !sameId(resource.id, `${rg}/providers/${String(resource.type)}/${String(resource.name)}`)) fail();
  }
  if (account) {
    const p = record(account.properties); const locations = list(p.locations); const backup = record(p.backupPolicy); const periodic = record(backup.periodicModeProperties);
    if (region(account.location) !== params.location || record(p.consistencyPolicy).defaultConsistencyLevel !== 'Strong' || p.enableFreeTier !== true || p.disableLocalAuth !== true || p.enableMultipleWriteLocations !== false || p.enableAutomaticFailover !== false || p.enableBurstCapacity === true || record(p.capacity).totalThroughputLimit !== (bootstrapVerification ? -1 : 1000) || locations.length !== 1 || region(locations[0]!.locationName) !== params.location || locations[0]!.failoverPriority !== 0 || backup.type !== 'Periodic' || periodic.backupIntervalInMinutes !== 240 || periodic.backupRetentionIntervalInHours !== 8 || (Array.isArray(p.capabilities) && p.capabilities.length !== 0)) fail();
  }
  for (const budget of list(snapshot.budgets)) {
    const p = record(budget.properties);
    const startDate = record(p.timePeriod).startDate;
    if (typeof startDate !== 'string' || startDate.length > 64 || !/^20[2-9][0-9]-(?:0[1-9]|1[0-2])-01(?:T00:00:00(?:\.000)?Z)?$/.test(startDate)) fail();
    if (budget.name !== `${params.namePrefix}-monthly` || !previous || p.category !== 'Cost' || p.timeGrain !== 'Monthly' || !Number.isFinite(p.amount) || Number(p.amount) <= 0) fail();
  }
  return typeof expected === 'string' ? expected : undefined;
}
export const azureRunner: Runner = async args => {
  const { stdout } = await promisify(execFile)('az', [...args, '--only-show-errors', '--output', 'json'], { shell: false, timeout: args[0] === 'deployment' && args[2] === 'create' ? 45 * 60_000 : 120_000, maxBuffer: 4_194_304 });
  return JSON.parse(stdout);
};
function completePage(value: unknown): Record<string, unknown>[] {
  const page = record(value); if (page.nextLink != null && page.nextLink !== '') fail();
  return list(page.value);
}
const rest = (ids: AzureInputs, url: string): string[] => ['rest', '--method', 'get', '--url', `https://management.azure.com${url}`, '--subscription', ids.subscription];
async function snapshotFor(ids: AzureInputs, runner: Runner): Promise<Snapshot> {
  const scope = ['--subscription', ids.subscription]; const group = ['--resource-group', ids.group, ...scope];
  const subscription = await runner(['account', 'show', ...scope]);
  const rg = await runner(['group', 'show', '--name', ids.group, ...scope]);
  const providers = []; for (const namespace of requiredProviders) providers.push(await runner(['provider', 'show', '--namespace', namespace, ...scope]));
  const accounts = completePage(await runner(rest(ids, `/subscriptions/${ids.subscription}/providers/Microsoft.DocumentDB/databaseAccounts?api-version=2025-04-15`)));
  const deployments = await runner(['deployment', 'group', 'list', ...group]);
  const identities = await runner(['identity', 'list', ...group]);
  const resources = await runner(['resource', 'list', ...group]);
  const budgets = completePage(await runner(rest(ids, `${resourceGroupId(ids)}/providers/Microsoft.Consumption/budgets?api-version=2024-08-01`)));
  return { subscription, group: rg, providers, accounts, deployments, identities, resources, budgets };
}
async function checkDatabase(ids: AzureInputs, account: string, runner: Runner) {
  const databases = completePage(await runner(rest(ids, `${account}/sqlDatabases?api-version=2025-04-15`)));
  if (databases.length !== 1 || record(record(databases[0]!.properties).resource).id !== 'metadata') fail();
  const database = `${account}/sqlDatabases/metadata`;
  const throughput = record(record(await runner(rest(ids, `${database}/throughputSettings/default?api-version=2025-04-15`))).properties);
  const allocation = record(throughput.resource);
  if (allocation.throughput !== 1000 || allocation.autoscaleSettings != null) fail();
  const containers = completePage(await runner(rest(ids, `${database}/containers?api-version=2025-04-15`)));
  const keys: Record<string, string> = { accounts: '/accountId', setups: '/setupId', identities: '/id' };
  if (containers.length !== 3) fail();
  const seen = new Set<string>();
  for (const container of containers) {
    const p = record(container.properties); const c = record(p.resource); const name = String(c.id); const pk = record(c.partitionKey);
    if (!keys[name] || seen.has(name) || c.defaultTtl !== -1 || pk.kind !== 'Hash' || JSON.stringify(pk.paths) !== JSON.stringify([keys[name]]) || p.options != null && Object.keys(record(p.options)).length !== 0) fail();
    seen.add(name);
  }
}
async function checkExistingResources(snapshot: Snapshot, ids: AzureInputs, params: DeploymentParameters, runner: Runner) {
  for (const resource of list(snapshot.resources)) {
    const type = String(resource.type).toLowerCase();
    if (type === 'microsoft.operationalinsights/workspaces') {
      const current = record(await runner(rest(ids, `${String(resource.id)}?api-version=2025-07-01`))); const p = record(current.properties);
      if (region(current.location) !== params.location || p.retentionInDays !== 30 || record(p.sku).name !== 'PerGB2018' || record(p.features).disableLocalAuth !== true || record(p.workspaceCapping).dailyQuotaGb !== 1) fail();
    }
    if (type === 'microsoft.app/containerapps') {
      const current = record(await runner(rest(ids, `${String(resource.id)}?api-version=2025-07-01`))); const p = record(current.properties); const configuration = record(p.configuration); const ingress = record(configuration.ingress); const template = record(p.template); const scale = record(template.scale); const containers = list(template.containers);
      if (region(current.location) !== params.location || configuration.activeRevisionsMode !== 'Single' || ingress.external !== true || ingress.targetPort !== 8080 || ingress.allowInsecure !== false || scale.minReplicas !== 0 || scale.maxReplicas !== 2 || template.terminationGracePeriodSeconds !== 30 || containers.length !== 1 || p.workloadProfileName !== 'Consumption' || (Array.isArray(configuration.registries) && configuration.registries.length !== 0) || (Array.isArray(configuration.secrets) && configuration.secrets.length !== 0)) fail();
      const container = containers[0]!; const resources = record(container.resources);
      if (container.name !== 'service' || resources.cpu !== 0.25 || resources.memory !== '0.5Gi') fail();
      const allowed = ['NORTUSCC_SERVICE_GITHUB_CLIENT_ID', 'NORTUSCC_SERVICE_COSMOS_ENDPOINT', 'NORTUSCC_SERVICE_COSMOS_DATABASE', 'NORTUSCC_SERVICE_MANAGED_IDENTITY_CLIENT_ID', 'NORTUSCC_SERVICE_HOST', 'NORTUSCC_SERVICE_PORT', 'NORTUSCC_SERVICE_OPEN_SIGNUP', 'NORTUSCC_SERVICE_ALLOWLIST', 'NORTUSCC_SERVICE_SHUTDOWN_GRACE_SECONDS'];
      const entries = list(container.env); if (entries.length !== allowed.length || new Set(entries.map(e => e.name)).size !== allowed.length || entries.some(e => !allowed.includes(String(e.name)) || typeof e.value !== 'string' || e.secretRef != null)) fail();
      const identity = entries.find(e => e.name === 'NORTUSCC_SERVICE_MANAGED_IDENTITY_CLIENT_ID');
      if (!identity || sameId(identity.value, ids.client)) fail();
    }
  }
}
export function validateOutputs(deployment: unknown, ids: AzureInputs, params: DeploymentParameters): Record<string, string> {
  const outputs = record(record(record(deployment).properties).outputs); const result: Record<string, string> = {};
  for (const name of ['endpoint', 'appName', 'runtimeIdentityResourceId', 'runtimeIdentityClientId', 'runtimeIdentityPrincipalId']) { const value = record(outputs[name]).value; if (typeof value !== 'string') fail(); result[name] = value; }
  if (!/^https:\/\/[a-z0-9.-]+\.azurecontainerapps\.io$/.test(result.endpoint!) || result.appName !== `${params.namePrefix}-service` || !sameId(result.runtimeIdentityResourceId, `${resourceGroupId(ids)}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${params.namePrefix}-runtime`) || result.runtimeIdentityClientId!.length !== 36 || result.runtimeIdentityPrincipalId!.length !== 36 || !uuid.test(result.runtimeIdentityClientId!) || !uuid.test(result.runtimeIdentityPrincipalId!) || sameId(result.runtimeIdentityClientId, ids.client)) fail();
  return result;
}
/** Initial preflight precedes mutation; new storage is verified before capped runtime deployment. */
export async function deploy(ids: AzureInputs, params: DeploymentParameters, armParameters: string, runner: Runner = azureRunner) {
  const snapshot = await snapshotFor(ids, runner);
  const account = evaluatePreflight(snapshot, ids, params);
  const create = ['deployment', 'group', 'create', '--name', 'hosted-service', '--resource-group', ids.group, '--subscription', ids.subscription, '--mode', 'Incremental', '--template-file', 'apps/service/infra/main.bicep', '--parameters', `@${armParameters}`];
  if (!account) {
    await runner([...create, 'bootstrapOnly=true']);
    const storage = await snapshotFor(ids, runner);
    const created = evaluatePreflight(storage, ids, params, true);
    if (!created || list(storage.identities).length !== 0 || list(storage.budgets).length !== 0 || list(storage.resources).some(resource => !String(resource.type).toLowerCase().startsWith('microsoft.documentdb/') && String(resource.type).toLowerCase() !== 'microsoft.resources/deployments')) fail();
    await checkDatabase(ids, created, runner);
  } else {
    await checkExistingResources(snapshot, ids, params, runner);
    await checkDatabase(ids, account, runner);
  }
  // The final account PUT restores the ceiling before any dependent runtime resource.
  // It does not PUT containers; their shared layout has already been verified above.
  const result = await runner(create);
  return validateOutputs(result, ids, params);
}
async function main() {
  const mode = process.argv[2]; if (mode !== 'inputs' && mode !== 'execute') fail();
  const ids = validateAzureInputs(process.env);
  if (mode === 'inputs') { console.log('Public CI deployment identity configuration valid.'); return; }
  await checkContext(process.env); await verifyEnvironment('hosted-production', process.env.GITHUB_TOKEN ?? '');
  const params = await loadParameters(process.env.IMAGE_REF ?? '');
  await checkImageCommit(process.env.IMAGE_COMMIT ?? '', process.env.GITHUB_SHA ?? '');
  await verifyPublicImage(params.image, process.env.IMAGE_COMMIT ?? '');
  const directory = await mkdtemp(join(tmpdir(), 'nortuscc-deploy-'));
  try {
    const file = join(directory, 'parameters.json');
    await writeFile(file, JSON.stringify({ $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#', contentVersion: '1.0.0.0', parameters: Object.fromEntries(Object.entries(params).map(([key, value]) => [key, { value }])) }), { mode: 0o600 });
    const outputs = await deploy(ids, params, file);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\nDeployment public outputs:\n\n\`\`\`json\n${JSON.stringify(outputs, null, 2)}\n\`\`\`\n`);
    console.log(JSON.stringify(outputs));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { await main(); } catch { console.error('Deployment preflight or execution failed.'); process.exitCode = 1; }
}
