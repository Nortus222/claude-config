import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, appendFile, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseDeploymentJson, validateDeploymentParameters } from './validate.ts';

export const repository = 'Nortus222/claude-config';
export const imageRepository = 'ghcr.io/nortus222/claude-config-service';
export const parameterPath = 'apps/service/infra/parameters.production.json';
const source = `https://github.com/${repository}`;
const commitPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
function fail(): never { throw new Error('Release verification failed.'); }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
export function assertReleaseContext(value: { event: string; ref: string; repository: string; captured: string; reviewed: string; head: string }): void {
  if (value.event !== 'workflow_dispatch' || value.ref !== 'refs/heads/main' || value.repository !== repository || value.captured.length !== 40 || !commitPattern.test(value.captured) || value.reviewed !== value.captured || value.head !== value.captured) fail();
}
export function assertProtectedEnvironment(environment: unknown, policies: unknown): void {
  const env = record(environment); const policy = record(env.deployment_branch_policy); const branches = record(policies);
  if (policy.protected_branches !== false || policy.custom_branch_policies !== true || !Array.isArray(env.protection_rules)) fail();
  const reviewers = env.protection_rules.map(record).find(rule => rule.type === 'required_reviewers');
  if (!reviewers || reviewers.prevent_self_review !== true || !Array.isArray(reviewers.reviewers) || reviewers.reviewers.length === 0 || !reviewers.reviewers.every(item => {
    const reviewer = record(item); return (reviewer.type === 'User' || reviewer.type === 'Team') && Number.isSafeInteger(record(reviewer.reviewer).id) && Number(record(reviewer.reviewer).id) > 0;
  })) fail();
  if (branches.total_count !== 1 || !Array.isArray(branches.branch_policies) || branches.branch_policies.length !== 1) fail();
  const branch = record(branches.branch_policies[0]);
  if (branch.name !== 'main' || branch.type !== 'branch') fail();
}
/** Every request is time/size bounded and disallows redirecting credentials. */
export async function readBounded(url: string, headers: Record<string, string>, transport: typeof fetch = fetch): Promise<string> {
  const response = await transport(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  return readResponse(response);
}
async function readResponse(response: Response): Promise<string> {
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1_048_576 || !response.body) return fail();
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1_048_576) return fail(); parts.push(value); }
  } finally { await reader.cancel(); }
  return Buffer.concat(parts).toString('utf8');
}
export async function verifyEnvironment(name: string, token: string, transport: typeof fetch = fetch): Promise<void> {
  if (name !== 'hosted-image' && name !== 'hosted-production') fail();
  const base = `https://api.github.com/repos/${repository}/environments/${name}`;
  const headers = { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const env = JSON.parse(await readBounded(base, headers, transport));
  const branches = JSON.parse(await readBounded(`${base}/deployment-branch-policies?per_page=100`, headers, transport));
  assertProtectedEnvironment(env, branches);
}
/** Public GHCR bearer tokens are obtained anonymously; no runner credential is read. */
export async function verifyPublicImage(image: string, reviewed: string, transport: typeof fetch = fetch): Promise<void> {
  if (!commitPattern.test(reviewed) || !image.startsWith(`${imageRepository}@`) || image.length !== 111 || !digestPattern.test(image.slice(imageRepository.length + 1))) fail();
  const tokenResponse = record(JSON.parse(await readBounded('https://ghcr.io/token?service=ghcr.io&scope=repository:nortus222/claude-config-service:pull', {}, transport)));
  if (typeof tokenResponse.token !== 'string' || tokenResponse.token.length < 1 || tokenResponse.token.length > 16_384 || /[\r\n]/.test(tokenResponse.token)) fail();
  const headers = { authorization: `Bearer ${tokenResponse.token}`, accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' };
  const root = 'https://ghcr.io/v2/nortus222/claude-config-service';
  const get = async (kind: 'manifests' | 'blobs', digest: unknown): Promise<Record<string, unknown>> => {
    if (typeof digest !== 'string' || !digestPattern.test(digest)) return fail();
    const url = `${root}/${kind}/${digest}`;
    let body: string;
    if (kind === 'blobs') {
      const response = await transport(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      if ([302, 303, 307, 308].includes(response.status)) {
        const target = new URL(response.headers.get('location') ?? '');
        if (target.protocol !== 'https:' || target.hostname !== 'pkg-containers.githubusercontent.com' || target.port || target.username || target.password || target.hash) return fail();
        await response.body?.cancel();
        body = await readBounded(target.href, {}, transport);
      } else body = await readResponse(response);
    } else body = await readBounded(url, headers, transport);
    if (`sha256:${createHash('sha256').update(body).digest('hex')}` !== digest) return fail();
    return record(JSON.parse(body));
  };
  let manifest = await get('manifests', image.slice(imageRepository.length + 1));
  if (manifest.schemaVersion !== 2) fail();
  if (manifest.mediaType === 'application/vnd.oci.image.index.v1+json' || manifest.mediaType === 'application/vnd.docker.distribution.manifest.list.v2+json') {
    if (!Array.isArray(manifest.manifests) || manifest.manifests.length > 20) fail();
    const matches = manifest.manifests.map(record).filter(item => { const p = record(item.platform); return p.os === 'linux' && p.architecture === 'amd64'; });
    if (matches.length !== 1) fail();
    manifest = await get('manifests', matches[0]!.digest);
  }
  if (manifest.schemaVersion !== 2 || !['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(String(manifest.mediaType))) fail();
  const config = await get('blobs', record(manifest.config).digest); const labels = record(record(config.config).Labels);
  if (config.os !== 'linux' || config.architecture !== 'amd64' || labels['org.opencontainers.image.source'] !== source || labels['org.opencontainers.image.revision'] !== reviewed) fail();
}
export async function loadParameters(image: string) {
  if (await realpath(parameterPath) !== `${await realpath('.')}/${parameterPath}`) fail();
  const raw = record(parseDeploymentJson(await readFile(parameterPath, 'utf8')));
  if (Object.hasOwn(raw, 'image')) fail();
  return validateDeploymentParameters({ ...raw, image });
}
export async function checkImageCommit(reviewed: string, captured: string, runGit: (args: readonly string[]) => Promise<void> = async args => {
  await promisify(execFile)('git', [...args], { timeout: 10_000, maxBuffer: 1024 });
}): Promise<void> {
  if (reviewed.length !== 40 || captured.length !== 40 || !commitPattern.test(reviewed) || !commitPattern.test(captured)) fail();
  await runGit(['merge-base', '--is-ancestor', reviewed, captured]);
}
export async function checkContext(env: NodeJS.ProcessEnv) {
  const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { timeout: 10_000, maxBuffer: 1024 });
  assertReleaseContext({ event: env.GITHUB_EVENT_NAME ?? '', ref: env.GITHUB_REF ?? '', repository: env.GITHUB_REPOSITORY ?? '', captured: env.GITHUB_SHA ?? '', reviewed: env.REVIEWED_COMMIT ?? '', head: stdout.trim() });
}
async function main() {
  const mode = process.argv[2];
  if (mode === 'published') {
    await checkContext(process.env);
    const digest = process.env.PUBLISHED_DIGEST ?? ''; if (digest.length !== 71 || !digestPattern.test(digest)) fail();
    const summary = `Published reviewed commit ${process.env.GITHUB_SHA}: ${imageRepository}@${digest}\n\nOwner must make a first GHCR publication public before deployment.\n`;
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    console.log(summary); return;
  }
  if (mode !== 'image' && mode !== 'deploy') fail();
  await checkContext(process.env);
  await verifyEnvironment(mode === 'image' ? 'hosted-image' : 'hosted-production', process.env.GITHUB_TOKEN ?? '');
  let summary = `Reviewed source: ${process.env.GITHUB_SHA}\n\nEnvironment: ${mode === 'image' ? 'hosted-image' : 'hosted-production'}\n`;
  if (mode === 'deploy') {
    const parameters = await loadParameters(process.env.IMAGE_REF ?? '');
    await checkImageCommit(process.env.IMAGE_COMMIT ?? '', process.env.GITHUB_SHA ?? '');
    await verifyPublicImage(parameters.image, process.env.IMAGE_COMMIT ?? '');
    summary += `\nReviewed image source commit: ${process.env.IMAGE_COMMIT}\n`;
    summary += `\nPublic immutable image: ${parameters.image}\n\nPublic parameters (${parameterPath}):\n\n\`\`\`json\n${JSON.stringify(parameters, null, 2)}\n\`\`\`\n`;
  } else summary += `\nPublish linux/amd64 to ${imageRepository}:${process.env.GITHUB_SHA}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { await main(); } catch { console.error('Release verification failed.'); process.exitCode = 1; }
}
