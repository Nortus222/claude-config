import { randomUUID } from 'node:crypto';
import { posix, join } from 'node:path';
import { Data, Effect } from 'effect';
import { isSkillAdditionName, normalizeSkillSource } from '@nortuscc/profile-engine';
import { isAlias, parseDocument, visit } from 'yaml';
import { Fs } from '../fs.ts';
import { MachinePaths } from '../paths.ts';
import { Processes } from '../processes.ts';
import type { TreeEntry } from './verify.ts';

export const SKILL_CANDIDATE_LIMITS = Object.freeze({
  timeoutMs: 30_000, cleanupTimeoutMs: 2_000, treeBytes: 2 * 1024 * 1024, skillBytes: 128 * 1024,
  metadataBytes: 8 * 1024 * 1024, candidates: 256,
} as const);

export type SkillCandidate = {
  readonly source: string;
  readonly revision: string;
  readonly sourceDir: string;
  readonly selectorName: string;
  readonly installedName: string;
  readonly description: string;
  readonly blob: string;
  readonly tree: string;
  readonly internal: boolean;
  // Unrelated YAML fields are data, never configuration or executable intent.
  readonly metadata: Readonly<Record<string, unknown>>;
};
export type SkillCandidatesFailure = 'invalid-source' | 'invalid-revision' | 'source-unavailable'
  | 'unsupported-layout' | 'unsupported-metadata' | 'ambiguous-selection' | 'limit-exceeded' | 'timed-out' | 'cleanup-failed';
export type SkillCandidatesResult =
  | { readonly ok: true; readonly source: string; readonly revision: string; readonly candidates: ReadonlyArray<SkillCandidate> }
  | { readonly ok: false; readonly reason: SkillCandidatesFailure; readonly retainedDirectory?: string };

// Effect cancellation remains interrupted; this defect preserves an unconfirmed shutdown receipt.
export class SkillCandidateCleanupFailed extends Data.TaggedError('SkillCandidateCleanupFailed')<{
  readonly temporaryDirectory: string;
}> {
  override get message() { return 'source cleanup failed; temporary source ownership remains unresolved'; }
}

class CandidateReadFailed extends Data.TaggedError('CandidateReadFailed')<{ readonly reason: SkillCandidatesFailure }> {}
const fail = (reason: SkillCandidatesFailure) => new CandidateReadFailed({ reason });
const sha = /^[0-9a-f]{40}$/;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ignored = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__']);
// Native skills 1.7.2 priority containers. Their descendants are searched to depth three.
const containers = ['skills', 'skills/.curated', 'skills/.experimental', 'skills/.system',
  ...['agents', 'claude', 'cline', 'codebuddy', 'codex', 'commandcode', 'continue', 'factory', 'github',
    'goose', 'grok', 'iflow', 'junie', 'kilo', 'kilocode', 'kimchi', 'kiro', 'minimax', 'mux', 'neovate',
    'opencode', 'openhands', 'pi', 'qoder', 'roo', 'trae', 'windsurf', 'zcode', 'zencoder'].map(n => `.${n}/skills`),
  '.posit/assistant/skills'];
const beneath = (path: string, dir: string) => dir === '.' || path.startsWith(`${dir}/`);
const safePath = (path: string) => path.length > 0 && !/[\\\x00-\x1f\x7f-\x9f]/.test(path)
  && !path.startsWith('/') && path.split('/').every(p => p !== '' && p !== '.' && p !== '..');

// Native sanitizeName, constrained to Task1's canonical declaration subset after transformation.
export const nativeInstalledName = (name: string) => name.toLowerCase().replace(/[^a-z0-9._]+/g, '-')
  .replace(/^[.\-]+|[.\-]+$/g, '').substring(0, 255) || 'unnamed-skill';

// Safe, bounded native --skill operand whose installed name the declaration layer supports.
export const isSkillCandidateSelector = (name: string): boolean => name.length > 0 && name.length <= 255
  && name === name.trim() && !['.', '..', '*'].includes(name) && !name.startsWith('-')
  && !/[/\\\x00-\x1f\x7f-\x9f]/.test(name) && isSkillAdditionName(nativeInstalledName(name));

type Entry = { readonly mode: string; readonly type: string; readonly id: string; readonly path: string };
const parseTree = (text: string): Entry[] => text.split('\0').filter(Boolean).map(line => {
  const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(line);
  if (!match || !safePath(match[4]!)) throw fail('unsupported-layout');
  return { mode: match[1]!, type: match[2]!, id: match[3]!, path: match[4]! };
});

const parseMetadata = (content: string): { selectorName: string; installedName: string; description: string; internal: boolean; metadata: Record<string, unknown> } => {
  // Only the native frontmatter envelope is supported. YAML parsing belongs to the pinned parser.
  const envelope = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!envelope) throw fail('unsupported-metadata');
  try {
    const doc = parseDocument(envelope[1]!, { schema: 'core', uniqueKeys: true, customTags: [], strict: true });
    if (doc.errors.length || doc.warnings.length) throw fail('unsupported-metadata');
    // No aliases or explicit tags: this bounded subset requires plain scalar metadata claims.
    visit(doc, (_, node) => { if (isAlias(node) || (record(node) && node.tag !== undefined)) throw fail('unsupported-metadata'); });
    const data: unknown = doc.toJS({ maxAliasCount: 0 });
    if (!record(data) || typeof data.name !== 'string' || typeof data.description !== 'string') throw fail('unsupported-metadata');
    if (/[\x00-\x1f\x7f-\x9f]/.test(data.name) || /[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(data.description)) throw fail('unsupported-metadata');
    const name = data.name.trim();
    const description = data.description.replace(/[\r\n]+/g, ' ').trim();
    if (!isSkillCandidateSelector(name) || !description) throw fail('unsupported-metadata');
    const canonical = nativeInstalledName(name);
    if (data.metadata !== undefined && !record(data.metadata)) throw fail('unsupported-metadata');
    const internal = record(data.metadata) ? data.metadata.internal : undefined;
    if (internal !== undefined && typeof internal !== 'boolean') throw fail('unsupported-metadata');
    return { selectorName: name, installedName: canonical, description, internal: internal === true, metadata: data };
  } catch {
    // Parser errors can include source text. Expose only the fixed reason.
    throw fail('unsupported-metadata');
  }
};

// Reads only Git objects at a verified commit. It never checks out or executes source files.
export const readSkillCandidates = (input: { readonly source: string; readonly revision?: string; readonly timeoutMs?: number; readonly observeTree?: (candidate: SkillCandidate, entries: readonly TreeEntry[]) => void }):
  Effect.Effect<SkillCandidatesResult, never, Fs | Processes | MachinePaths> => Effect.gen(function* () {
    const source = normalizeSkillSource(input.source);
    if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > SKILL_CANDIDATE_LIMITS.timeoutMs)) return { ok: false, reason: 'limit-exceeded' } as const;
    if (!source || source !== input.source) return { ok: false, reason: 'invalid-source' } as const;
    if (input.revision !== undefined && !sha.test(input.revision)) return { ok: false, reason: 'invalid-revision' } as const;
    const fs = yield* Fs;
    const processes = yield* Processes;
    const dir = join((yield* MachinePaths).stateRoot, 'tmp', `candidates-${randomUUID()}`);
    let shutdownUnconfirmed = false;
    const run = (args: readonly string[], maxBytes = SKILL_CANDIDATE_LIMITS.treeBytes, cwd = dir) =>
      processes.run({ cmd: 'git', args: ['-c', `core.hooksPath=${join(dir, 'disabled-hooks')}`, '-c', 'init.templateDir=',
        '-c', 'core.fsmonitor=false', ...args], cwd, output: 'capture', stderr: 'capture', captureLimit: { stdout: maxBytes, stderr: 16 * 1024 },
        envAllow: ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP'],
        env: { HOME: dir, USERPROFILE: dir, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '' },
        onCleanup: outcome => { if (!outcome.joined) shutdownUnconfirmed = true; },
      }).pipe(Effect.catch(error => {
        if (error.reason === 'capture cleanup deadline exceeded') shutdownUnconfirmed = true;
        return Effect.fail(fail(error.reason === 'capture byte limit exceeded' ? 'limit-exceeded'
          : error.reason === 'capture cleanup deadline exceeded' ? 'cleanup-failed' : 'source-unavailable'));
      }),
        Effect.flatMap(result => result.code === 0 ? Effect.succeed(result.stdout) : Effect.fail(fail('source-unavailable'))));
    const body = Effect.gen(function* () {
      yield* fs.writeTextAtomic(join(dir, '.prepare'), '');
      yield* fs.remove(join(dir, '.prepare'));
      yield* run(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--quiet', '--', `https://github.com/${source}.git`, dir], 16 * 1024, (yield* MachinePaths).stateRoot);
      if (input.revision) yield* run(['fetch', '--depth', '1', '--quiet', 'origin', input.revision], 16 * 1024);
      const revision = (yield* run(['rev-parse', '--verify', `${input.revision ?? 'HEAD'}^{commit}`], 128)).trim();
      if (!sha.test(revision) || (input.revision !== undefined && revision !== input.revision)) return yield* Effect.fail(fail('source-unavailable'));
      const rootTree = (yield* run(['rev-parse', '--verify', `${revision}^{tree}`], 128)).trim();
      if (!sha.test(rootTree)) return yield* Effect.fail(fail('source-unavailable'));
      const entries = yield* run(['ls-tree', '-r', '-t', '-z', revision]).pipe(
        Effect.flatMap(text => Effect.try({ try: () => parseTree(text), catch: () => fail('unsupported-layout') })));
      const trees = new Map(entries.filter(e => e.type === 'tree').map(e => [e.path, e.id]));
      trees.set('.', rootTree);
      const skillEntries = entries.filter(e => posix.basename(e.path) === 'SKILL.md');
      const skills = new Map(skillEntries.map(e => [posix.dirname(e.path), e]));
      let bytes = 0;
      const accepted: SkillCandidate[] = [];
      const read = (sourceDir: string) => Effect.gen(function* () {
        const entry = skills.get(sourceDir)!;
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)
          || entries.some(e => beneath(e.path, sourceDir) && (e.mode === '120000' || e.mode === '160000')))
          return yield* Effect.fail(fail('unsupported-layout'));
        if (accepted.length >= SKILL_CANDIDATE_LIMITS.candidates) return yield* Effect.fail(fail('limit-exceeded'));
        const sizeText = (yield* run(['cat-file', '-s', entry.id], 128)).trim();
        const size = Number(sizeText);
        if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(size)) return yield* Effect.fail(fail('source-unavailable'));
        bytes += size;
        if (size > SKILL_CANDIDATE_LIMITS.skillBytes || bytes > SKILL_CANDIDATE_LIMITS.metadataBytes) return yield* Effect.fail(fail('limit-exceeded'));
        const content = yield* run(['cat-file', 'blob', entry.id], SKILL_CANDIDATE_LIMITS.skillBytes);
        const metadata = yield* Effect.try({ try: () => parseMetadata(content), catch: () => fail('unsupported-metadata') });
        const tree = trees.get(sourceDir);
        if (!tree) return yield* Effect.fail(fail('unsupported-layout'));
        const candidate = { source, revision, sourceDir, blob: entry.id, tree, ...metadata };
        accepted.push(candidate);
        input.observeTree?.(candidate, entries.filter(e => e.type === 'blob' && beneath(e.path, sourceDir)).map(e => ({
          mode: e.mode, sha: e.id, path: sourceDir === '.' ? e.path : e.path.slice(sourceDir.length + 1),
        })));
      });
      if (skills.has('.')) {
        yield* read('.');
        return { ok: true, source, revision, candidates: accepted } as const;
      }
      // These files can change native discovery; a dominant root skill bypasses their selection effects.
      if (entries.some(e => ['skills-lock.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'].includes(e.path)
        || ((e.mode === '120000' || e.mode === '160000')
          && ['.claude-plugin', ...containers].some(container => container === e.path || beneath(container, e.path)))))
        return yield* Effect.fail(fail('unsupported-layout'));
      const roots: string[] = [];
      const blockedByRoot = (path: string) => roots.some(root => beneath(path, root));
      const children = new Map<string, string[]>();
      for (const directory of [...trees.keys()].filter(d => d !== '.').sort()) {
        const parent = posix.dirname(directory);
        const siblings = children.get(parent) ?? [];
        siblings.push(directory);
        children.set(parent, siblings);
      }
      const walk = (parent: string, maxDepth: number, depth = 1): void => {
        for (const child of children.get(parent) ?? []) {
          if (blockedByRoot(child)) continue;
          if (skills.has(child)) { roots.push(child); continue; }
          if (depth < maxDepth && !ignored.has(posix.basename(child))) walk(child, maxDepth, depth + 1);
        }
      };
      walk('.', 1);
      for (const container of containers) if (!blockedByRoot(container)) walk(container, 3);
      // Native priority loops can re-enter a container beneath an earlier skill root. Refuse that
      // shape instead of hiding independently selectable skills among the root's copied resources.
      if (roots.some(root => containers.some(container => (container === root || beneath(container, root))
        && skillEntries.some(entry => {
          const directory = posix.dirname(entry.path);
          if (directory === root || !beneath(directory, container)) return false;
          const parts = posix.relative(container, directory).split('/');
          return parts.length <= 3 && !parts.slice(0, -1).some(p => ignored.has(p));
        })))) return yield* Effect.fail(fail('unsupported-layout'));
      if (!roots.length) {
        const fallback = (parent: string, depth: number): void => {
          if (depth > 5) return;
          for (const child of children.get(parent) ?? []) {
            if (ignored.has(posix.basename(child))) continue;
            if (skills.has(child)) roots.push(child);
            fallback(child, depth + 1);
          }
        };
        fallback('.', 1);
        // Native recursive fallback would select nested SKILL.md too. That shape needs an explicit subpath contract.
        if (roots.some(r => roots.some(other => r !== other && beneath(r, other)))) return yield* Effect.fail(fail('unsupported-layout'));
      }
      if (!roots.length || skillEntries.some(e => !roots.some(r => e.path === `${r}/SKILL.md` || beneath(e.path, r))))
        return yield* Effect.fail(fail('unsupported-layout'));
      if (roots.length > SKILL_CANDIDATE_LIMITS.candidates) return yield* Effect.fail(fail('limit-exceeded'));
      for (const root of roots) yield* read(root);
      const selectors = new Set<string>(); const destinations = new Set<string>();
      for (const candidate of accepted) {
        if (selectors.has(candidate.selectorName.toLowerCase()) || destinations.has(candidate.installedName))
          return yield* Effect.fail(fail('ambiguous-selection'));
        selectors.add(candidate.selectorName.toLowerCase()); destinations.add(candidate.installedName);
      }
      return { ok: true, source, revision, candidates: accepted } as const;
    });
    // Process cleanup precedes bounded filesystem cleanup. A removal timeout leaves ownership unresolved,
    // even if an unabortable filesystem operation finishes later.
    let cleanupFailed = false;
    return yield* body.pipe(Effect.timeout(input.timeoutMs ?? SKILL_CANDIDATE_LIMITS.timeoutMs),
      Effect.ensuring(Effect.suspend(() => shutdownUnconfirmed ? Effect.void
        : fs.remove(dir).pipe(Effect.timeout(SKILL_CANDIDATE_LIMITS.cleanupTimeoutMs), Effect.catch(() => Effect.sync(() => { cleanupFailed = true; }))))),
      Effect.onInterrupt(() => shutdownUnconfirmed || cleanupFailed
        ? Effect.die(new SkillCandidateCleanupFailed({ temporaryDirectory: dir })) : Effect.void),
      Effect.catch(error => Effect.succeed({ ok: false, reason: error instanceof CandidateReadFailed ? error.reason
        : error._tag === 'TimeoutError' ? 'timed-out' : 'source-unavailable' } as const)),
      Effect.map(result => shutdownUnconfirmed || cleanupFailed
        ? { ok: false, reason: 'cleanup-failed', retainedDirectory: dir } as const : result));
  }).pipe(Effect.catch(() => Effect.succeed({ ok: false, reason: 'source-unavailable' } as const)));
