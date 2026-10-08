targetScope = 'resourceGroup'

@minLength(2)
@maxLength(32)
param location string
@minLength(3)
@maxLength(20)
param namePrefix string
@minLength(1)
@maxLength(100)
param githubClientId string
@maxLength(100)
param allowlistedLogins array
param openSignup bool
@minValue(1)
@maxValue(1000000)
param budgetAmount int
@minLength(1)
@maxLength(5)
param budgetContactEmails array
param budgetStartDate string
@minLength(111)
@maxLength(111)
param image string

var databaseName = 'metadata'
var suffix = uniqueString(resourceGroup().id, namePrefix)
var cosmosName = '${namePrefix}-${suffix}'
var containers = [
  { name: 'accounts', partitionKey: '/accountId' }
  { name: 'setups', partitionKey: '/setupId' }
  { name: 'identities', partitionKey: '/id' }
]

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: '${namePrefix}-runtime'
  location: location
}
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2025-04-15' = {
  name: cosmosName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    consistencyPolicy: { defaultConsistencyLevel: 'Strong' }
    locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }]
    enableMultipleWriteLocations: false
    enableAutomaticFailover: false
    enableFreeTier: true
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    minimalTlsVersion: 'Tls12'
    capacity: { totalThroughputLimit: 1000 }
    backupPolicy: {
      type: 'Periodic'
      periodicModeProperties: { backupIntervalInMinutes: 240, backupRetentionIntervalInHours: 8 }
    }
  }
}
resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2025-04-15' = {
  parent: cosmos
  name: databaseName
  properties: { resource: { id: databaseName }, options: { throughput: 1000 } }
}
resource container 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2025-04-15' = [for item in containers: {
  parent: database
  name: item.name
  properties: {
    resource: { id: item.name, partitionKey: { paths: [item.partitionKey], kind: 'Hash', version: 2 }, defaultTtl: -1 }
    options: {}
  }
}]
var databaseScope = '${cosmos.id}/dbs/${databaseName}'
resource dataRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleDefinitions@2025-04-15' = {
  parent: cosmos
  name: guid(cosmos.id, 'metadata-items')
  properties: {
    roleName: '${namePrefix}-metadata-items'
    type: 'CustomRole'
    assignableScopes: [databaseScope]
    permissions: [{ dataActions: [
      'Microsoft.DocumentDB/databaseAccounts/readMetadata'
      'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/create'
      'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/read'
      'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/replace'
      'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/upsert'
      'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/delete'
      'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/executeQuery'
      'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/readChangeFeed'
    ] }]
  }
}
resource metadataRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleDefinitions@2025-04-15' = {
  parent: cosmos
  name: guid(cosmos.id, 'account-metadata')
  properties: {
    roleName: '${namePrefix}-account-metadata'
    type: 'CustomRole'
    assignableScopes: [cosmos.id]
    permissions: [{ dataActions: ['Microsoft.DocumentDB/databaseAccounts/readMetadata'] }]
  }
}
resource dataAssignment 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2025-04-15' = {
  parent: cosmos
  name: guid(cosmos.id, runtimeIdentity.id, 'metadata-items')
  properties: { principalId: runtimeIdentity.properties.principalId, roleDefinitionId: dataRole.id, scope: databaseScope }
  dependsOn: [container]
}
resource metadataAssignment 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2025-04-15' = {
  parent: cosmos
  name: guid(cosmos.id, runtimeIdentity.id, 'account-metadata')
  properties: { principalId: runtimeIdentity.properties.principalId, roleDefinitionId: metadataRole.id, scope: cosmos.id }
}
resource logs 'Microsoft.OperationalInsights/workspaces@2025-07-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30, features: { disableLocalAuth: true }, workspaceCapping: { dailyQuotaGb: 1 } }
}
resource environment 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: '${namePrefix}-environment'
  location: location
  properties: {
    appLogsConfiguration: { destination: 'azure-monitor' }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: environment
  name: '${namePrefix}-logs'
  properties: {
    workspaceId: logs.id
    logs: [
      { category: 'ContainerAppConsoleLogs', enabled: true }
      { category: 'ContainerAppSystemLogs', enabled: true }
    ]
  }
}
resource app 'Microsoft.App/containerApps@2025-07-01' = {
  name: '${namePrefix}-service'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${runtimeIdentity.id}': {} } }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 8080, allowInsecure: false, transport: 'auto' }
    }
    template: {
      terminationGracePeriodSeconds: 30
      scale: { minReplicas: 0, maxReplicas: 2, rules: [{ name: 'http', http: { metadata: { concurrentRequests: '10' } } }] }
      containers: [{
        name: 'service'
        image: image
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: [
          { name: 'NORTUSCC_SERVICE_GITHUB_CLIENT_ID', value: githubClientId }
          { name: 'NORTUSCC_SERVICE_COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
          { name: 'NORTUSCC_SERVICE_COSMOS_DATABASE', value: databaseName }
          { name: 'NORTUSCC_SERVICE_MANAGED_IDENTITY_CLIENT_ID', value: runtimeIdentity.properties.clientId }
          { name: 'NORTUSCC_SERVICE_HOST', value: '0.0.0.0' }
          { name: 'NORTUSCC_SERVICE_PORT', value: '8080' }
          { name: 'NORTUSCC_SERVICE_OPEN_SIGNUP', value: openSignup ? 'true' : 'false' }
          { name: 'NORTUSCC_SERVICE_ALLOWLIST', value: join(allowlistedLogins, ',') }
          { name: 'NORTUSCC_SERVICE_SHUTDOWN_GRACE_SECONDS', value: '10' }
        ]
        probes: [
          { type: 'Startup', httpGet: { path: '/readyz', port: 8080, scheme: 'HTTP' }, initialDelaySeconds: 1, periodSeconds: 20, timeoutSeconds: 2, failureThreshold: 10, successThreshold: 1 }
          { type: 'Readiness', httpGet: { path: '/readyz', port: 8080, scheme: 'HTTP' }, initialDelaySeconds: 1, periodSeconds: 5, timeoutSeconds: 2, failureThreshold: 3, successThreshold: 1 }
          { type: 'Liveness', httpGet: { path: '/v1/health', port: 8080, scheme: 'HTTP' }, initialDelaySeconds: 1, periodSeconds: 10, timeoutSeconds: 2, failureThreshold: 3, successThreshold: 1 }
        ]
      }]
    }
  }
  dependsOn: [dataAssignment, metadataAssignment, diagnostics]
}
resource budget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: '${namePrefix}-monthly'
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      actual50: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 50, thresholdType: 'Actual', contactEmails: budgetContactEmails }
      actual80: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 80, thresholdType: 'Actual', contactEmails: budgetContactEmails }
      actual100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Actual', contactEmails: budgetContactEmails }
      forecast100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Forecasted', contactEmails: budgetContactEmails }
    }
  }
}
output endpoint string = 'https://${app.properties.configuration.ingress.fqdn}'
output appName string = app.name
output runtimeIdentityResourceId string = runtimeIdentity.id
output runtimeIdentityClientId string = runtimeIdentity.properties.clientId
output runtimeIdentityPrincipalId string = runtimeIdentity.properties.principalId
