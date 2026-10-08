# Hosted service delivery

This directory prepares the existing metadata service for an owner-approved Azure
release. No cloud deployment, OAuth sign-in, LIVE acceptance or billing proof has
been performed. Issues #51 and #81 remain open. Local image/emulator tests and
Bicep compilation do not establish Azure identity, Strong consistency, capacity,
regional availability or ingress behavior.

`service-image.yml` and `service-deploy.yml` accept **workflow_dispatch only**.
Both reject forks, tags and branches other than this repository's `main`.
`reviewed_commit` must equal the run's captured `github.sha` and checked-out HEAD;
an approval waiting while main advances still releases that captured source.
The checkout retains no Git credentials. Ordinary PR/push checks build locally,
exercise the real image against the isolated emulator and compile Bicep; they
cannot publish or obtain cloud OIDC credentials.

## Owner setup

Run from the feature checkout when ready to perform external setup yourself:

```bash
bash apps/service/infra/owner-setup.sh
```

The repeatable wizard opens documentation and guides five manual stages. It was
syntax-checked and statically tested, never run end-to-end by an agent. Its shared
library is unchanged; stages never call the library's secret or GitHub write
helpers. Each run captures six **public** values into a new task-owned
`apps/service/infra/owner-public.XXXXXX` snapshot, leaving prior files intact.
Do not enter credentials or commit those snapshots. It performs no login, cloud
mutation, app registration, publication, deployment or acceptance request.

1. Choose subscription/tenant/region and create a dedicated resource group.
   Inspect every subscription Cosmos account: new deployment needs the one
   unused free-tier slot. Verify Container Apps Consumption/Cosmos availability,
   quotas and billing currency. Register `Microsoft.App`, `Microsoft.DocumentDB`,
   `Microsoft.ManagedIdentity`, `Microsoft.OperationalInsights`,
   `Microsoft.Insights` and `Microsoft.Consumption` yourself.
2. Create separate `hosted-image` and `hosted-production` GitHub environments.
   Require at least one reviewer; selected deployment branches must contain
   **only branch `main`**, no tags or wildcards. Disable administrator bypass.
   Prevent self review when another eligible approver exists; a single-owner
   setup must document that limitation. Read-only inspection on 2026-10-08 found
   zero environments. Naming one in YAML is insufficient and can create an
   unprotected environment, so prepare rejects missing environments, empty
   reviewers, all/protected-branches policies and any policy other than exact
   branch main. The REST response verifies reviewer/branch rules; bypass and
   practical self-review settings remain owner checks.
3. Create a CI-only Entra app/service principal with **no client secret**. Its
   federated issuer is `https://token.actions.githubusercontent.com`, audience
   `api://AzureADTokenExchange`. Verify the repository's actual OIDC subject
   configuration, including organization/repository custom templates and the
   immutable-ID defaults for repositories created after July 15, 2026. If the
   legacy subject is actually configured, use exactly
   `repo:Nortus222/claude-config:environment:hosted-production` (case sensitive).
   Otherwise use the actual immutable-ID subject; never broaden to a wildcard.
   Environment subjects omit the branch, so main restrictions remain essential.
4. Create/select a GitHub OAuth App through Settings → Developer settings →
   OAuth Apps. Supply owner-controlled homepage/callback URLs, enable Device
   Flow and copy only its public Client ID. The adapter requests **no OAuth
   scopes** and uses **no client secret**. Device-flow authorization and user
   acceptance are later, separately authorized work.
5. Review public configuration on main, publish only after separate approval,
   then manually make the first GHCR package public before deploying.

Set these public **environment Variables**, not secrets, in `hosted-production`:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | CI app Application (client) ID, lowercase UUID |
| `AZURE_TENANT_ID` | Directory (tenant) ID, lowercase UUID |
| `AZURE_SUBSCRIPTION_ID` | Intended subscription ID, lowercase UUID |
| `AZURE_RESOURCE_GROUP` | Dedicated existing group, simple letters/digits/underscore/hyphen name |

Use an owner-created custom CI role assigned **only to the dedicated resource
group**, with the following control-plane Actions and empty DataActions. These
allow the checked-in incremental template and its read-only preflight; they do
not grant deletes, shared-key retrieval, Graph access or ARM RBAC allocation:

```text
Microsoft.Resources/subscriptions/resourceGroups/read
Microsoft.Resources/subscriptions/resourceGroups/resources/read
Microsoft.Resources/deployments/read
Microsoft.Resources/deployments/write
Microsoft.Resources/deployments/validate/action
Microsoft.Resources/deployments/operations/read
Microsoft.Resources/deployments/operationStatuses/read
Microsoft.DocumentDB/databaseAccounts/read
Microsoft.DocumentDB/databaseAccounts/write
Microsoft.DocumentDB/databaseAccounts/sqlDatabases/read
Microsoft.DocumentDB/databaseAccounts/sqlDatabases/write
Microsoft.DocumentDB/databaseAccounts/sqlDatabases/throughputSettings/read
Microsoft.DocumentDB/databaseAccounts/sqlDatabases/throughputSettings/write
Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/read
Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/write
Microsoft.DocumentDB/databaseAccounts/sqlRoleDefinitions/read
Microsoft.DocumentDB/databaseAccounts/sqlRoleDefinitions/write
Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments/read
Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments/write
Microsoft.ManagedIdentity/userAssignedIdentities/read
Microsoft.ManagedIdentity/userAssignedIdentities/write
Microsoft.ManagedIdentity/userAssignedIdentities/assign/action
Microsoft.App/managedEnvironments/read
Microsoft.App/managedEnvironments/write
Microsoft.App/managedEnvironments/join/action
Microsoft.App/containerApps/read
Microsoft.App/containerApps/write
Microsoft.OperationalInsights/workspaces/read
Microsoft.OperationalInsights/workspaces/write
Microsoft.Insights/diagnosticSettings/read
Microsoft.Insights/diagnosticSettings/write
Microsoft.Insights/diagnosticSettingsCategories/read
Microsoft.Consumption/budgets/read
Microsoft.Consumption/budgets/write
```

At subscription scope, use a separate custom **read-only** role containing only
`Microsoft.DocumentDB/databaseAccounts/read` (complete free-tier eligibility
inventory) and `Microsoft.Resources/subscriptions/providers/read` (registration
and regional provider metadata). No subscription-wide resource Reader, Contributor,
Owner, key-listing or role-assignment authority is needed. The owner creates the
group, registers providers and allocates these roles beforehand. This helper
cannot perform those bootstrap operations. Actual authorization/propagation must
be verified in a later approved deployment; a missing permission fails rather
than silently broadening the role. Cosmos SQL assignments are provider-owned
**data-plane** role resources; they are distinct from
`Microsoft.Authorization/roleAssignments`.

Review against the official [management provider Actions](https://learn.microsoft.com/en-us/azure/role-based-access-control/permissions/management-and-governance),
[database provider Actions](https://learn.microsoft.com/en-us/azure/role-based-access-control/permissions/databases),
[compute provider Actions](https://learn.microsoft.com/en-us/azure/role-based-access-control/permissions/compute)
and [monitor provider Actions](https://learn.microsoft.com/en-us/azure/role-based-access-control/permissions/monitor).

The template creates `${namePrefix}-runtime`, a different UAMI selected by its
client ID. Existing identity/client-ID collisions fail preflight; returned runtime
client ID must differ from CI after deployment. No CI IDs, federated-token files,
OIDC tokens, client secrets or registry credentials enter application environment.

Official setup references: [environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[environment REST metadata](https://docs.github.com/en/rest/deployments/environments#get-an-environment),
[branch-policy REST metadata](https://docs.github.com/en/rest/deployments/branch-policies#list-deployment-branch-policies),
[Azure federation](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect),
[OIDC subject configuration](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims),
[GitHub device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow),
[Azure provider registration](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-providers-and-types).

## Public deployment configuration

The fixed `apps/service/infra/parameters.production.json` is deliberately absent.
The owner must create it from `parameters.example.json`, replace invalid
placeholders, validate, review and merge it to main. Dispatch cannot choose a
parameter path. The helper checks its real path to prevent a symlink escaping the
checkout. Its eight flat fields are `location`, `namePrefix`, `githubClientId`,
`allowlistedLogins`, `openSignup`, `budgetAmount`, `budgetContactEmails` and
`budgetStartDate`. Closed signup plus an empty allowlist is a valid deny-all setup.
Keep prefix/group stable across upgrades and rollback; budget amount is in the
subscription's billing currency. Owner must check the allowed current monthly
budget start-date window; the validator only checks first-day date syntax.

```bash
node apps/service/infra/validate.ts \
  apps/service/infra/parameters.production.json \
  ghcr.io/nortus222/claude-config-service@sha256:REPLACE_WITH_64_LOWERCASE_HEX
```

A valid invocation prints canonical ARM parameters containing those eight values
and the separate image value. Unknown/nested keys, duplicate JSON keys, missing
values, control characters, credentials, mutable tags and foreign images fail
with a constant redacted error. No path/config input is executed as shell code;
Git and Azure helpers use executable argument arrays and `shell:false`.

## Publish, deploy and roll back

The owner must separately authorize actual publication/deployment. Nothing in
this code batch dispatches either workflow.

1. Dispatch **service-image** on main with `reviewed_commit` equal to the exact
   captured commit. The read-only prepare job verifies current protections and
   builds the reviewed image locally. Inspect its summary and source before
   `hosted-image` approval. Only that approved job has `packages:write`; it has no
   OIDC permission. It publishes `linux/amd64`, commit tag and OCI source/revision
   labels, then records the immutable digest in the job summary. Full action
   commits and the Node base digest are pinned.
2. New GHCR packages default private even for a public source repository. Owner
   must manually change `claude-config-service` visibility to public after first
   publication. Deployer obtains a GHCR pull bearer token anonymously; no
   GITHUB_TOKEN/PAT/runner registry credential is used for image inspection or
   runtime pull. It hashes index/manifest/config, requires one amd64 Linux image
   and the expected OCI repository/revision. One config-blob redirect to GitHub's
   HTTPS `pkg-containers.githubusercontent.com` CDN is allowed without forwarding
   its bearer header; all requests are time/size bounded. Private/unavailable or
   changed-host images fail, never trigger a credential fallback.
3. Dispatch **service-deploy** on main with `reviewed_commit` for the current
   infrastructure/config checkout, `image_commit` for the reviewed image source
   and `image_ref` exactly
   `ghcr.io/nortus222/claude-config-service@sha256:<64 lowercase hex>`.
   `image_commit` must be an ancestor of the captured main commit; prepare verifies
   OCI revision against that image commit. The public image/config/source summary
   and offline Bicep compile precede `hosted-production` approval. Inspect all
   three inputs, public parameters and template before approving.
4. The approved job rechecks source/protections/image/config and public CI IDs
   **before Azure login**. Only it has `id-token:write`; it cannot publish packages.
   After OIDC, preflight reads the selected subscription/group, provider
   registrations/regional declarations and complete subscription Cosmos inventory
   before choosing the internal new-account bootstrap or existing-account path. It
   refuses a paid
   fallback, a different free-tier account, unowned group resources, unexpected
   Strong/key/throughput/budget policy, CI/runtime identity collisions or truncated
   ARM inventory pages. Existing metadata database/container settings must retain
   manual shared 1000 RU/s, three partition keys and TTL -1. Owned budgets must remain
   Cost/Monthly with valid existing values; newly reviewed amount/date updates
   are allowed and their creation-window validation remains ARM's responsibility. Existing workspace/app policy
   also rejects altered compute/scale/logging or runtime secrets/federation.
5. The previous fixed deployment's `outputResources` identifies the sole owned
   Cosmos account without guessing ARM `uniqueString`. Missing/ambiguous ownership
   or an orphan account after a failed first deployment stops release. Recovery
   requires separately reviewed owner inspection/reconciliation; do not delete
   the account, adopt unrelated data or bypass free-tier validation automatically.
   Read calls have a 120-second bound. Each deployment phase has a 45-minute bound
   inside a 120-minute job; timeout/cancellation may leave provisioning running.
   Inspect the existing deployment before retrying. The NEW-account path first
   deploys only the Strong/free-tier/key-disabled account, shared manual 1000 RU/s
   database and three containers with the ceiling temporarily disabled. No app,
   runtime identity, roles, logs or budget is created in that phase. The helper
   re-reads ownership/account policy and verifies the exact shared storage layout,
   then deploys the final ceiling 1000 before dependent runtime resources. Existing
   accounts run only the capped final path and never have their ceiling relaxed.
   The final template intentionally does not PUT databases/containers; its
   default path requires the helper's existing storage proof. The internal
   `bootstrapOnly` flag is not a dispatch/configuration input. Do not invoke the
   template directly as a substitute for the helper. A partial/uncapped bootstrap
   retry fails closed, even when owned; manual reconciliation needs separate review.
   [ADR0028](../../../docs/adr/0028-hosted-cosmos-bootstrap-order.md) records this
   ordering and its bounded initial provisioning exception. ARM success is **not runtime
   readiness**. Public outputs are endpoint, appName, runtimeIdentityResourceId,
   runtimeIdentityClientId and runtimeIdentityPrincipalId; identity outputs are
   checked for correct group/name and a client ID distinct from CI.
6. For rollback, review an earlier **digest plus image_commit**, retain current
   reviewed main infrastructure/public configuration and dispatch the same
   protected deploy workflow. If configuration/template must change, review and
   merge that rollback configuration to main first. No moving image tag, database
   deletion, resource-group deletion or account reset is a rollback mechanism.

Official release references: [manual dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch),
[GHCR public access/digests](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
[OCI distribution](https://github.com/opencontainers/distribution-spec/blob/main/spec.md),
[Container Apps image requirements](https://learn.microsoft.com/en-us/azure/container-apps/containers),
[free-tier eligibility](https://learn.microsoft.com/en-us/azure/cosmos-db/free-tier),
[Cosmos data-plane RBAC](https://learn.microsoft.com/en-us/azure/cosmos-db/reference-data-plane-security).

## Operations and limits

After an authorized deployment, inspect exact `GET /v1/health` (storage-free strict
v1 liveness) and `GET /readyz` (startup recovery/readiness) on the returned HTTPS
endpoint. Use only these fixed probe URLs: no query arguments, credentials or
payload diagnostics. ARM completion cannot prove identity-role propagation or
runtime recovery. Inspect revision readiness and the constant redacted lifecycle
logs if startup fails; never enable token, request-body or OAuth-response logging.
Readiness records the last recovery result, not an on-demand storage query.

Consumption remains 0.25 vCPU / 0.5 GiB, single revision, min 0 / max 2. Platform maintenance
can temporarily prewarm extra replicas; max 2 is not a hard physical process/spend
ceiling. Scale 0 pauses serial expiry recovery and adds image pull/provisioning/
startup latency to the next request. Startup recovers before bind and uses three
bounded 60-second phases. The custom startup probe allows roughly 200 seconds (10 failures,
20s period), while HTTP ingress independently times out at 240 seconds; neither is a
cold-start guarantee. Readiness calls `/readyz`; liveness calls `/v1/health`.
Platform SIGTERM grace 30 seconds exceeds runtime 10 seconds. No scheduler or warm-up resource is
added. [Scaling](https://learn.microsoft.com/en-us/azure/container-apps/scale-app),
[cold starts](https://learn.microsoft.com/en-us/azure/container-apps/cold-start),
[probes](https://learn.microsoft.com/en-us/azure/container-apps/health-probes),
[ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview),
[lifecycle](https://learn.microsoft.com/en-us/azure/container-apps/application-lifecycle-management).

Quotas stay in memory per process: 10 device starts/socket-peer-IP/hour and 60
requests/machine-token/minute. Forwarded headers are not trusted, so a reverse
proxy's socket peer can share the device-start quota. Restart resets these
quotas; replicas do not share quotas or GitHub adapter cooldown. Stored revision
quota remains 100/setup/day. These limits do not establish distributed abuse
control.

Cosmos is one Strong region, key auth disabled, freeTier true, fixed shared 1000 RU/s
and account provisioning ceiling 1000 RU/s. Only one free-tier account is allowed per
subscription; 1000 RU/s and 25 GB discounts do not make all Azure resources free.
Shared-throughput minimum grows with storage/history/container count, and automatic
storage-driven minimum throughput can exceed the configured account ceiling.
Strong reads cost twice the read RUs of weaker consistency. No paid fallback,
autoscale or multi-region failover is introduced. Azure currently rejects creation
of offerless containers while the ceiling is enabled, which is why the NEW-only
storage bootstrap precedes final capping. The template never supplies dedicated
container throughput. Container-list `properties.options` is only a coarse
unexpected-shape guard, **not proof that a dedicated offer is absent**. The
[container ThroughputSetting API](https://learn.microsoft.com/en-us/rest/api/cosmos-db-resource-provider/sql-resources/get-sql-container-throughput?view=rest-cosmos-db-resource-provider-2025-04-15)
documents a successful offer read but no authoritative absence response; the helper
never treats arbitrary 400/404/auth/network failures as no offer. Successful final
capping cannot set a limit below actual provisioned allocation, providing the
bootstrap allocation gate before the app starts. Independent control-plane offer
absence/response-shape proof remains part of the later owner-approved cloud
acceptance; no data-plane credential or CI data-plane role is added for it.
[Throughput ceiling exception](https://learn.microsoft.com/en-us/azure/cosmos-db/limit-total-account-throughput),
[throughput/limits](https://learn.microsoft.com/en-us/azure/cosmos-db/concepts-limits),
[consistency](https://learn.microsoft.com/en-us/azure/cosmos-db/consistency-levels).

TTL -1 enables per-item TTL; expired queries and eventual physical purge differ.
Bound claims retain cleanup evidence until restartable recovery, including stopped
intervals. Permanent opaque account/setup fences follow [ADR0025](../../../docs/adr/0025-hosted-partition-consistency.md)
and [ADR0026](../../../docs/adr/0026-hosted-device-expiry.md).
Periodic backups have a 240-minute interval / 8-hour retention. Scale 0, asynchronous
TTL, backups and permanent fences mean **no hard physical-erasure deadline**.
[TTL semantics](https://learn.microsoft.com/en-us/azure/cosmos-db/time-to-live).

Only console/system diagnostic categories go to keyless Azure Monitor routing.
Log Analytics retention is 30 days with 1 GB/day ingestion cap and local auth disabled.
Ingestion can appear minutes later; the cap can overshoot and excess is billed,
then logging pauses until its reset. Configured retention is not an immediate
physical-erasure guarantee. Resource-group monthly alerts are actual 50/80/100%
and forecast 100%; budget data/notifications are delayed. **Budgets alert; they do
not stop spending.** Review storage, logs and subscription Consumption grants as
well as compute; there is no overall spend cap.
[Log routing](https://learn.microsoft.com/en-us/azure/container-apps/log-options),
[retention](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure),
[daily-cap overshoot](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/daily-cap),
[budget alerts](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets),
[Consumption billing](https://learn.microsoft.com/en-us/azure/container-apps/billing).
