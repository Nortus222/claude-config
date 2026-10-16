import { randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { Cause, Data, Effect } from 'effect';
import { Fs, Processes, SKILLS_CLI_VERSION, nodeFs } from '@nortuscc/machine';
import { Git, GitFailed } from './git.ts';
import { guardedCacheRead, joinedDeadline, ordinaryFallback, SourceCleanupFailed, SourceDeadline } from './services.ts';
import { sourceUrl } from './sources.ts';
import { cacheFolder } from './upstream.ts';

export type SkillSummary = { name: string; description: string };
export type DiscoveryResult =
  | { kind: 'complete'; source: string; commit: string; skills: SkillSummary[] }
  | { kind: 'unavailable'; source: string; reason: 'cli-failed' | 'unparseable' | 'head-moved' | 'timeout' | 'too-large' };

export const DISCOVERY_LIMITS = { timeoutMs: 60_000, stdoutBytes: 1_048_576, stderrBytes: 16_384 } as const;
export const SKILL_TEXT_MAX_BYTES = 262_144;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Accept only the pinned Git listing transcript, including its optional plugin groups.
export function parseSkillsList(stdout: string): { ok: true; skills: SkillSummary[] } | { ok: false } {
  const lines = stripVTControlCharacters(stdout).replace(/\r\n/g, '\n').split('\n')
    .filter(line => line.trim() !== '' && line !== '│');
  let i = 0;
  if (/^●   [a-z0-9-]+  Agent detected — installing non-interactively$/.test(lines[i] ?? '')) i++;
  else if (lines[i] === '┌   skills ') {
    i++;
    if (lines[i] === '│  Tip: use the --yes (-y) and --global (-g) flags to install without prompts.') i++;
  }
  if (!/^◇  Source: https:\/\/\S+$/.test(lines[i++] ?? '')) return { ok: false };
  if (!/^(?:[◒◐◓◑]  Cloning repository…)*◇  Repository cloned$/.test(lines[i++] ?? '')) return { ok: false };
  const count = /^◇  Found ([1-9]\d*) (skill|skills)$/.exec(lines[i++] ?? '');
  if (!count || (count[1] === '1') !== (count[2] === 'skill')) return { ok: false };
  if (lines[i++] !== '◇  Available Skills') return { ok: false };
  const skills: SkillSummary[] = [];
  const names = new Set<string>();
  let groupNeedsRecord = false;
  while (i < lines.length && lines[i] !== '└  Use --skill <name> to install specific skills') {
    const line = lines[i++]!;
    if (/^[A-Z][A-Za-z0-9]*(?: [A-Z][A-Za-z0-9]*)*$/.test(line)) {
      if (groupNeedsRecord) return { ok: false };
      groupNeedsRecord = true;
      continue;
    }
    const name = /^│    (\S(?:.*\S)?)$/.exec(line)?.[1];
    if (!name || names.has(name)) return { ok: false };
    const description: string[] = [];
    while (/^│      \S/.test(lines[i] ?? '')) description.push(lines[i++]!.slice(7).trim());
    if (!description.length) return { ok: false };
    skills.push({ name, description: description.join(' ') });
    names.add(name);
    groupNeedsRecord = false;
  }
  if (groupNeedsRecord || lines[i++] !== '└  Use --skill <name> to install specific skills'
    || i !== lines.length || skills.length !== Number(count[1])) return { ok: false };
  return { ok: true, skills };
}

type UnavailableReason = Extract<DiscoveryResult, { kind: 'unavailable' }>['reason'];
class DiscoveryFailed extends Data.TaggedError('DiscoveryFailed')<{ readonly reason: UnavailableReason }> {}

// Listing owns a fresh HOME and scratch directory. Only executable lookup variables are inherited.
export const discoverSkills = (source: string, options: { tempDir: string }): Effect.Effect<DiscoveryResult, never, Processes> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const processes = yield* Processes;
    const home = join(options.tempDir, `skills-list-${randomUUID()}`);
    let cleanupUncertain = false;
    const env = {
      HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home,
      NO_COLOR: '1', FORCE_COLOR: '0', DISABLE_TELEMETRY: '1',
      SKILLS_CLONE_TIMEOUT_MS: String(DISCOVERY_LIMITS.timeoutMs), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
    };
    const run = (cmd: string, args: readonly string[]) => processes.run({
      cmd, args, cwd: home, env, envAllow: ['PATH', 'SystemRoot', 'WINDIR'], output: 'capture', stderr: 'capture',
      captureLimit: { stdout: DISCOVERY_LIMITS.stdoutBytes, stderr: DISCOVERY_LIMITS.stderrBytes },
      onCleanup: outcome => { if (!outcome.joined) cleanupUncertain = true; },
    }).pipe(
      Effect.mapError(error => {
        if (error.reason === 'capture cleanup deadline exceeded') cleanupUncertain = true;
        return new DiscoveryFailed({ reason: error.reason === 'capture byte limit exceeded' ? 'too-large' : 'cli-failed' });
      }),
      Effect.flatMap(result => Buffer.byteLength(result.stdout) > DISCOVERY_LIMITS.stdoutBytes
        || Buffer.byteLength(result.stderr ?? '') > DISCOVERY_LIMITS.stderrBytes
        ? Effect.fail(new DiscoveryFailed({ reason: 'too-large' }))
        : result.code !== 0 ? Effect.fail(new DiscoveryFailed({ reason: 'cli-failed' })) : Effect.succeed(result.stdout)),
    );
    const head = () => run('git', ['ls-remote', '--symref', '--', sourceUrl(source), 'HEAD']).pipe(
      Effect.flatMap(text => {
        const heads = text.split('\n').filter(line => /^[0-9a-f]+\tHEAD$/.test(line));
        const sha = heads[0]?.split('\t')[0] ?? '';
        return heads.length === 1 && FULL_SHA.test(sha) ? Effect.succeed(sha)
          : Effect.fail(new DiscoveryFailed({ reason: 'cli-failed' }));
      }),
    );
    const body = Effect.gen(function* () {
      const before = yield* head();
      const stdout = yield* run('npx', ['-y', `skills@${SKILLS_CLI_VERSION}`, 'add', '--', source, '--list', '--full-depth']);
      const after = yield* head();
      if (before !== after) return yield* Effect.fail(new DiscoveryFailed({ reason: 'head-moved' }));
      const parsed = parseSkillsList(stdout);
      if (!parsed.ok) return yield* Effect.fail(new DiscoveryFailed({ reason: 'unparseable' }));
      return { kind: 'complete', source, commit: before, skills: parsed.skills } satisfies DiscoveryResult;
    });
    return yield* Effect.acquireUseRelease(
      fs.createDirectory(options.tempDir, { recursive: true }).pipe(Effect.andThen(fs.createDirectory(home))),
      () => joinedDeadline(body, DISCOVERY_LIMITS.timeoutMs),
      () => Effect.suspend(() => cleanupUncertain
        ? Effect.die(new SourceCleanupFailed({ retainedDirectory: home })) : fs.remove(home).pipe(Effect.orDie)),
    );
  }).pipe(
    Effect.catchCause(cause => {
      if (cause.reasons.some(reason => !Cause.isFailReason(reason))) return Effect.failCause(cause) as Effect.Effect<never>;
      const error = cause.reasons.find(Cause.isFailReason)?.error;
      return Effect.succeed({ kind: 'unavailable', source,
        reason: error instanceof DiscoveryFailed ? error.reason : error instanceof SourceDeadline ? 'timeout' : 'cli-failed',
      } satisfies DiscoveryResult);
    }),
    Effect.provide(nodeFs),
  );

type SkillContents = { path: string; text: string; files: string[] } | { unavailable: string };

// Name scalars cover plain and quoted frontmatter without interpreting unrelated YAML fields.
function frontmatterName(text: string): string | undefined {
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (frontmatter === undefined) return undefined;
  const claims = frontmatter.split(/\r?\n/).filter(line => /^name\s*:/.test(line));
  if (claims.length !== 1) return undefined;
  const scalar = claims[0]!.replace(/^name\s*:\s*/, '').trim();
  if (scalar.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(scalar);
      return typeof value === 'string' ? value.trim() : undefined;
    } catch { return undefined; }
  }
  if (scalar.startsWith("'")) return /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(scalar)?.[1]?.replace(/''/g, "'").trim();
  if (/^[!&*|>{[\]}]/.test(scalar)) return undefined;
  return scalar.replace(/\s+#.*$/, '').trim() || undefined;
}

// Read immutable Git objects without a checkout. Shallow fetches never alter the watcher's history cache.
export const readSkillContents = (source: string, commit: string, name: string, options: { cacheDir: string }):
  Effect.Effect<SkillContents, never, Git | Fs> => {
  if (!FULL_SHA.test(commit)) return Effect.succeed({ unavailable: 'Invalid source commit' });
  const dir = cacheFolder(join(options.cacheDir, 'skill-contents'), sourceUrl(source));
  return guardedCacheRead(dir, Effect.gen(function* () {
    const fs = yield* Fs;
    const git = yield* Git;
    const fail = () => Effect.fail(new GitFailed({ reason: 'Skill contents unavailable' }));
    const run = (args: readonly string[]) => git.run(args, { cwd: dir });
    if (!(yield* fs.exists(dir))) yield* git.run(['init', '--bare', '--template=', '--', dir]);
    yield* run(['fetch', '--depth', '1', '--no-tags', '--', sourceUrl(source), commit]);
    if ((yield* run(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim() !== commit) return yield* fail();
    const tree = yield* run(['ls-tree', '-r', '-z', commit]);
    const entries: { mode: string; id: string; path: string }[] = [];
    for (const line of tree.split('\0').filter(Boolean)) {
      const match = /^(\d{6}) (?:blob|commit) ([0-9a-f]+)\t(.+)$/.exec(line);
      if (!match || !FULL_SHA.test(match[2]!)) return yield* fail();
      entries.push({ mode: match[1]!, id: match[2]!, path: match[3]! });
    }
    let selected: { path: string; text: string } | undefined;
    for (const entry of entries.filter(entry => posix.basename(entry.path) === 'SKILL.md')) {
      if (!['100644', '100755'].includes(entry.mode)) return yield* fail();
      const size = (yield* run(['cat-file', '-s', entry.id])).trim();
      if (!/^\d+$/.test(size) || Number(size) > SKILL_TEXT_MAX_BYTES) return yield* fail();
      const text = yield* run(['cat-file', 'blob', entry.id]);
      if (Buffer.byteLength(text) > SKILL_TEXT_MAX_BYTES) return yield* fail();
      if (frontmatterName(text) !== name) continue;
      if (selected) return yield* fail();
      selected = { path: posix.dirname(entry.path), text };
    }
    if (!selected) return yield* fail();
    const prefix = selected.path === '.' ? '' : `${selected.path}/`;
    return { ...selected, files: entries.filter(entry => entry.mode !== '160000' && entry.path.startsWith(prefix))
      .map(entry => entry.path.slice(prefix.length)) };
  })).pipe(ordinaryFallback(() => ({ unavailable: 'Skill contents unavailable' })));
};
