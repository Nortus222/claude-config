import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const repository = 'Nortus222/claude-config';
export const endpoint = `https://github.com/${repository}/releases/download/desktop-stable-channel/latest.json`;
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commit = /^[a-f0-9]{40}$/;
const run = promisify(execFile);
function fail(message: string): never { throw new Error(`Desktop release verification failed: ${message}`); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid object');
  return value as Record<string, unknown>;
}
export function assertContext(value: { event: string; ref: string; repository: string; captured: string; reviewed: string; head: string; main: string; version: string; versions: string[] }): void {
  if (value.event !== 'workflow_dispatch' || value.ref !== 'refs/heads/main' || value.repository !== repository || !commit.test(value.captured) || value.reviewed !== value.captured || value.head !== value.captured || value.main !== value.captured) fail('dispatch must name the exact reviewed main SHA');
  if (!stable.test(value.version) || value.versions.length !== 3 || value.versions.some(version => version !== value.version)) fail('desktop package, Cargo and Tauri versions must match the stable version');
}
export function releaseOverlay(publicKey: string) {
  if (!publicKey || publicKey.length > 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) fail('owner updater public key is required');
  const decoded = Buffer.from(publicKey, 'base64');
  if (decoded.toString('base64') !== publicKey) fail('invalid public key encoding');
  const lines = decoded.toString('utf8').trimEnd().split('\n');
  const key = Buffer.from(lines[1] ?? '', 'base64');
  if (lines.length !== 2 || !lines[0]?.startsWith('untrusted comment: ') || key.length !== 42 || !['Ed', 'ED'].includes(key.subarray(0, 2).toString()) || key.toString('base64') !== lines[1]) fail('invalid minisign public key');
  return { bundle: { createUpdaterArtifacts: true, targets: ['app', 'dmg'] }, plugins: { updater: { pubkey: publicKey, endpoints: [endpoint], requireSignedVersion: true, allowDowngrades: false } } };
}
async function api(path: string, token: string, transport: typeof fetch, method = 'GET', body?: unknown, bytes?: Buffer): Promise<{ status: number; data: unknown }> {
  const url = path.startsWith('https://uploads.github.com/') ? path : `https://api.github.com/repos/${repository}${path}`;
  const response = await transport(url, { method, redirect: 'error', signal: AbortSignal.timeout(120_000), headers: { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(bytes ? { 'content-type': 'application/octet-stream' } : body ? { 'content-type': 'application/json' } : {}) }, body: bytes ? new Uint8Array(bytes) : body ? JSON.stringify(body) : undefined });
  if (response.status === 404 && method === 'GET') { await response.body?.cancel(); return { status: 404, data: null }; }
  if (!response.ok) { await response.body?.cancel(); fail(`GitHub ${method} request refused (${response.status})`); }
  if (method === 'DELETE') { await response.body?.cancel(); return { status: response.status, data: null }; }
  if (Number(response.headers.get('content-length') ?? 0) > 1_048_576 || !response.body) fail('oversized GitHub response');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 1_048_576) fail('oversized GitHub response'); chunks.push(next.value); } } finally { await reader.cancel(); }
  return { status: response.status, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}
export async function verifyChecks(sha: string, token: string, transport: typeof fetch = fetch): Promise<void> {
  if (!commit.test(sha)) fail('invalid source SHA');
  const data = object((await api(`/actions/runs?head_sha=${sha}&event=push&per_page=100`, token, transport)).data);
  if (!Array.isArray(data.workflow_runs) || typeof data.total_count !== 'number' || data.total_count > 100) fail('missing or incomplete check history');
  for (const path of ['macos.yml', 'linux.yml', 'windows.yml']) {
    const matches = data.workflow_runs.map(object).filter(item => item.path === `.github/workflows/${path}` && item.head_sha === sha && item.event === 'push' && item.head_branch === 'main').sort((a, b) => Number(b.id) - Number(a.id));
    if (matches[0]?.status !== 'completed' || matches[0]?.conclusion !== 'success') fail(`${path} has not passed on the reviewed main SHA`);
  }
}
export interface ReleaseInput {
  version: string; commit: string; publicKey: string; archive: string; dmg: string; signature: string;
  architecture: string; artifactUrl: string; expectedHash: string; expectedSize: number; notes: string;
  verifySignature: (archive: string, signature: string, version: string, publicKey: string) => Promise<void>;
}
export interface PreparedRelease {
  tag: string; commit: string; publicKey: string;
  assets: { name: string; path: string; sha256: string; size: number }[];
  latest: { version: string; notes: string; platforms: { 'darwin-aarch64': { signature: string; url: string } } };
}
export async function prepareRelease(input: ReleaseInput): Promise<PreparedRelease> {
  releaseOverlay(input.publicKey);
  if (!stable.test(input.version) || !commit.test(input.commit) || input.architecture !== 'darwin-aarch64') fail('stable arm64 source required');
  const tag = `desktop-v${input.version}`;
  const url = `https://github.com/${repository}/releases/download/${tag}/Nortuscc.app.tar.gz`;
  if (input.artifactUrl !== url || basename(input.archive) !== 'Nortuscc.app.tar.gz' || basename(input.signature) !== 'Nortuscc.app.tar.gz.sig' || basename(input.dmg) !== `Nortuscc_${input.version}_aarch64.dmg`) fail('artifact identity mismatch');
  if (typeof input.notes !== 'string' || Buffer.byteLength(input.notes) > 32_768 || input.notes.includes('\0')) fail('invalid release notes');
  const assets = [];
  for (const path of [input.archive, input.signature, input.dmg]) {
    const bytes = await readFile(path);
    if (!bytes.length || bytes.length > 1_073_741_824) fail('invalid artifact size');
    assets.push({ path, name: basename(path), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
  }
  if (assets[0]!.sha256 !== input.expectedHash || assets[0]!.size !== input.expectedSize || !Number.isSafeInteger(input.expectedSize)) fail('artifact hash or size mismatch');
  const signature = (await readFile(input.signature, 'utf8')).trim();
  if (!signature || signature.length > 16_384) fail('invalid signature');
  await input.verifySignature(input.archive, input.signature, input.version, input.publicKey);
  return { tag, commit: input.commit, publicKey: input.publicKey, assets, latest: { version: input.version, notes: input.notes, platforms: { 'darwin-aarch64': { signature, url } } } };
}
async function currentStableVersion(transport: typeof fetch): Promise<string> {
  let url = endpoint;
  for (let redirect = 0; redirect <= 5; redirect++) {
    const response = await transport(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = new URL(response.headers.get('location') ?? '', url);
      if (next.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname) || next.username || next.password || next.port || next.hash) fail('invalid stable metadata redirect');
      url = next.href; continue;
    }
    if (!response.ok || !response.body) fail('existing stable metadata is unavailable');
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 65_536) fail('oversized stable metadata'); parts.push(next.value); } } finally { await reader.cancel(); }
    const version = object(JSON.parse(Buffer.concat(parts).toString('utf8'))).version;
    if (typeof version !== 'string' || !stable.test(version)) fail('invalid stable metadata version');
    return version;
  }
  return fail('too many stable metadata redirects');
}
function isNewer(next: string, previous: string): boolean {
  const a = next.split('.').map(BigInt); const b = previous.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (a[i]! > b[i]!) return true; if (a[i]! < b[i]!) return false; }
  return false;
}
function id(value: unknown): number { const result = object(value).id; if (!Number.isSafeInteger(result) || Number(result) <= 0) fail('invalid GitHub release id'); return Number(result); }
export async function publishRelease(prepared: PreparedRelease, token: string, transport: typeof fetch = fetch): Promise<void> {
  if ((await api(`/releases/tags/${prepared.tag}`, token, transport)).status !== 404) fail('versioned releases are immutable; choose a new version');
  if ((await api(`/git/ref/tags/${prepared.tag}`, token, transport)).status !== 404) fail('versioned tag already exists');
  // Re-hash transferred artifacts before creating any release.
  for (const asset of prepared.assets) { const bytes = await readFile(asset.path); if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) fail('transferred artifact changed'); }
  const stableRelease = await api('/releases/tags/desktop-stable-channel', token, transport);
  let stableId: number | undefined; let oldAsset: number | undefined;
  if (stableRelease.status !== 404) {
    const record = object(stableRelease.data); stableId = id(record);
    if (record.draft !== false || record.prerelease !== false || !Array.isArray(record.assets) || record.assets.length > 1) fail('stable channel must contain metadata only');
    if (record.assets.length) { const asset = object(record.assets[0]); if (asset.name !== 'latest.json') fail('unexpected stable channel asset'); oldAsset = id(asset); if (!isNewer(prepared.latest.version, await currentStableVersion(transport))) fail('stable channel must advance to a newer version'); }
  }
  const releaseId = id((await api('/releases', token, transport, 'POST', { tag_name: prepared.tag, target_commitish: prepared.commit, name: `Desktop ${prepared.latest.version}`, body: prepared.latest.notes, draft: true, prerelease: false, make_latest: 'false' })).data);
  for (const asset of prepared.assets) await api(`https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`, token, transport, 'POST', undefined, await readFile(asset.path));
  await api(`/releases/${releaseId}`, token, transport, 'PATCH', { draft: false, make_latest: 'false' });
  if (!stableId) stableId = id((await api('/releases', token, transport, 'POST', { tag_name: 'desktop-stable-channel', target_commitish: prepared.commit, name: 'Desktop stable channel', body: 'Mutable updater metadata only. Versioned desktop releases own the immutable artifacts.', draft: false, prerelease: false, make_latest: 'false' })).data);
  if (oldAsset) await api(`/releases/assets/${oldAsset}`, token, transport, 'DELETE');
  await api(`https://uploads.github.com/repos/${repository}/releases/${stableId}/assets?name=latest.json`, token, transport, 'POST', undefined, Buffer.from(JSON.stringify(prepared.latest, null, 2) + '\n'));
}
async function checkContext(env: NodeJS.ProcessEnv) {
  const [head, main, pkg, tauri, cargo] = await Promise.all([run('git', ['rev-parse', 'HEAD']), run('git', ['rev-parse', 'origin/main']), readFile('apps/desktop/package.json', 'utf8'), readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8'), readFile('apps/desktop/src-tauri/Cargo.toml', 'utf8')]);
  assertContext({ event: env.GITHUB_EVENT_NAME ?? '', ref: env.GITHUB_REF ?? '', repository: env.GITHUB_REPOSITORY ?? '', captured: env.GITHUB_SHA ?? '', reviewed: env.REVIEWED_COMMIT ?? '', head: head.stdout.trim(), main: main.stdout.trim(), version: env.RELEASE_VERSION ?? '', versions: [JSON.parse(pkg).version, JSON.parse(tauri).version, cargo.match(/^version = "([^"]+)"/m)?.[1] ?? ''] });
  await verifyChecks(env.GITHUB_SHA ?? '', env.GITHUB_TOKEN ?? '');
}
async function main() {
  const env = process.env; const mode = process.argv[2];
  if (mode === 'publish' && env.DESKTOP_PUBLISH !== 'true') fail('publication must be explicitly enabled');
  await checkContext(env);
  if (mode === 'overlay') { await writeFile(env.RELEASE_OVERLAY ?? fail('overlay path required'), JSON.stringify(releaseOverlay(env.DESKTOP_UPDATER_PUBLIC_KEY ?? ''), null, 2)); return; }
  if (mode !== 'prepare' && mode !== 'publish') fail('unknown mode');
  const dir = resolve(env.RELEASE_ARTIFACTS ?? fail('artifact directory required')); const archive = join(dir, 'Nortuscc.app.tar.gz'); const bytes = await readFile(archive);
  const prepared = await prepareRelease({ version: env.RELEASE_VERSION ?? '', commit: env.GITHUB_SHA ?? '', publicKey: env.DESKTOP_UPDATER_PUBLIC_KEY ?? '', archive, signature: archive + '.sig', dmg: join(dir, `Nortuscc_${env.RELEASE_VERSION}_aarch64.dmg`), architecture: 'darwin-aarch64', artifactUrl: `https://github.com/${repository}/releases/download/desktop-v${env.RELEASE_VERSION}/Nortuscc.app.tar.gz`, expectedHash: createHash('sha256').update(bytes).digest('hex'), expectedSize: bytes.length, notes: env.RELEASE_NOTES ?? '', verifySignature: async (artifact, signature, version, publicKey) => { await run(env.RELEASE_VERIFIER ?? fail('native verifier required'), ['--verify-update-release', artifact, signature, version, publicKey], { timeout: 120_000, maxBuffer: 16_384 }); } });
  const manifest = join(dir, 'prepared.json');
  if (mode === 'prepare') { await writeFile(manifest, JSON.stringify(prepared, null, 2)); await writeFile(join(dir, 'latest.json'), JSON.stringify(prepared.latest, null, 2)); }
  else {
    const expected = object(JSON.parse(await readFile(manifest, 'utf8')));
    // Paths change between runners; bytes and every public identity must agree.
    const stripPaths = (value: PreparedRelease) => ({ ...value, assets: value.assets.map(({ path: _path, ...rest }) => rest) });
    if (JSON.stringify(stripPaths(prepared)) !== JSON.stringify(stripPaths(expected as unknown as PreparedRelease))) fail('prepared manifest changed');
    await publishRelease(prepared, env.GITHUB_TOKEN ?? fail('publication token required'));
  }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : 'Desktop release verification failed.'); process.exitCode = 1; }
}
