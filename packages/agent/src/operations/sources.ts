import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { AgentClock } from '../clock.ts';
import { join } from 'node:path';
import { Context, Effect, Exit, Layer } from 'effect';
import { normalizeRepoUrl } from '@nortuscc/sync';
import { normalizeSkillSource, settingsComplaints } from '@nortuscc/profile-engine';
import { authorDigest, Fs, MachinePaths, canonical } from '@nortuscc/machine';
import {
  draftChangelog,
  joinedDeadline,
  machineGit,
  pinImpactWithServices,
  sourcesFrom,
  sourceUrl,
  watchSourcesWithServices,
  watchCheckout,
  type SourceReport,
  type LocalReport,
} from '@nortuscc/source-watch';
import { SessionError } from '../ipc/session.ts';
import type { JobInspection } from '../job.ts';
import type { AgentServices } from '../layer.ts';
import { decodeOperationInput, decodeOperationOutput, type OperationInput, type OperationOutput } from './index.ts';
import { safeOwnerString } from './safety.ts';

export class AgentSourceEnvironment extends Context.Service<
  AgentSourceEnvironment,
  { readonly env?: Readonly<Record<string, string>> }
>()('agent/SourceEnvironment') {}
export const sourceEnvironment = (env?: Readonly<Record<string, string | undefined>>) =>
  Layer.succeed(
    AgentSourceEnvironment,
    env === undefined
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
        },
  );
// Public GitHub declarations keep their identity; other declarations expose only a stable digest.
export const sourceIdentity = (source: string): string =>
  /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(source) && safeOwnerString(source)
    ? source
    : `source:${createHash('sha256').update(source).digest('hex')}`;
// Session-owned receipts are bounded and expire with the existing operation clock.
export const sourceReadCache = () => ({
  cursors: new Map<
    string,
    { binding: string; offset: number; expires: number; observed: ReadonlyMap<string, string> }
  >(),
  observations: new Map<string, string>(),
});
export type SourceReadCache = ReturnType<typeof sourceReadCache>;
export type SourceOperation = 'watchSources' | 'inspectSourceDiff' | 'pinImpact' | 'draftChangelog';
const stale = () => new SessionError('UNKNOWN_PLAN', 'Source observation changed; check sources again');
const invalid = () =>
  new SessionError('INVALID_REQUEST', 'Select a declared source and its observed revision and skill identities');
const digest = (value: unknown) => authorDigest(canonical(value))!;
const cursor = (value: string | undefined, binding: string, total: number) => {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      Object.keys(parsed).sort().join() !== 'binding,offset' ||
      parsed.binding !== binding ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0 ||
      parsed.offset > total
    )
      throw stale();
    return parsed.offset as number;
  } catch {
    throw stale();
  }
};
const next = (binding: string, offset: number) =>
  Buffer.from(JSON.stringify({ binding, offset })).toString('base64url');
const skillRows = (
  source: string,
  skills: readonly { name: string; status: 'changed' | 'unchanged' | 'removed' | 'missing' }[],
) => skills.map((skill) => ({ skillId: `skill:${source}/${skill.name}`, name: skill.name, status: skill.status }));
// The engine normalizes source policy when machine additions participate; legacy declarations stay exact.
const policyIdentity = (inspection: JobInspection) => inspection.desired.skills.some(skill => skill.targets !== undefined)
  ? (source: string) => normalizeSkillSource(source) ?? source
  : (source: string) => source;
const affectedSkills = (inspection: JobInspection, source: string) => {
  const identity = policyIdentity(inspection);
  return inspection.desired.skills.filter(skill => identity(skill.source) === identity(source));
};
const relativeOwnerPath = (path: string) =>
  safeOwnerString(path) && !/^[\\/]|[\x00-\x1f\x7f]/.test(path) && !path.split(/[\\/]/).includes('..');
const safeLocal = (local: LocalReport) =>
  local.skills.length <= 256 && local.uncommitted.length <= 256 && local.unpushed.length <= 100 &&
  (local.branch === undefined || safeOwnerString(local.branch)) && local.uncommitted.every(relativeOwnerPath) &&
  local.skills.every(s => safeOwnerString(s.name) && relativeOwnerPath(s.path)) &&
  local.unpushed.every(c => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(c.sha) && safeOwnerString(c.subject));
const localRow = (sourceId: string, local: LocalReport) => ({
  observation: digest(local),
  status: local.status,
  ...(local.branch === undefined ? {} : { branch: local.branch }),
  unpushed: local.unpushed.map(({ sha, subject }) => ({ sha, subject })),
  uncommitted: local.uncommitted,
  skills: local.skills.map(s => ({ skillId: `skill:${sourceId}/${s.name}`, name: s.name, hasDiff: !!s.skillMd })),
});
const diffSelection = (a: OperationInput<'inspectSourceDiff'>) => 'localObservation' in a
  ? { sourceId: a.sourceId, localObservation: a.localObservation, skillId: a.skillId }
  : { sourceId: a.sourceId, fromRevision: a.fromRevision, toRevision: a.toRevision, skillId: a.skillId };
// Validate owner metadata before constructing drafts or retaining cursor bindings.
const safeReport = (report: SourceReport) => {
  const revisions = [report.baseline, report.latest].filter((r) => r !== undefined);
  return (
    (report.local === undefined || safeLocal(report.local)) &&
    report.skills.length <= 256 &&
    report.added.length <= 100 &&
    revisions.every((r) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(r.sha) && r.tags.every(safeOwnerString)) &&
    [...report.skills.map((s) => s.name), ...report.added, ...report.commits.map((c) => c.subject)].every(
      safeOwnerString,
    )
  );
};

export const readSourceOperation = <N extends SourceOperation>(
  name: N,
  input: OperationInput<N>,
  inspection: JobInspection | undefined,
  generation: number,
  cache: SourceReadCache,
  configuredRepository?: string | null,
): Effect.Effect<OperationOutput<N>, SessionError, AgentServices> =>
  Effect.gen(function* () {
    const args = yield* Effect.try({ try: () => decodeOperationInput(name, input), catch: invalid });
    if (args.scope.kind !== 'machine')
      return yield* Effect.fail(new SessionError('UNSUPPORTED_SCOPE', 'Source reads support machine scope only'));
    if (!inspection)
      return yield* Effect.fail(new SessionError('NO_REPORT', 'Inspect the machine before reading sources'));
    if (!inspection.trusted)
      return yield* Effect.fail(
        new SessionError('APP_UNAVAILABLE', 'Open the app repository trust action before reading sources'),
      );
    const configured = yield* MachinePaths;
    const environment = yield* AgentSourceEnvironment;
    const localUrl = pathToFileURL(configured.repo).href;
    // Reuse the selected setup owner's identity; no checkout is inferred from caller input.
    const checkouts = Object.fromEntries(inspection.desired.skills
      .filter(s => s.source === localUrl ||
        (configuredRepository != null && normalizeRepoUrl(sourceUrl(s.source)) === configuredRepository))
      .map(s => [s.source, configured.repo]));
    const declared = sourcesFrom(inspection.desired, { checkouts });
    const known = (sourceId: string) => {
      const source = declared.find((s) => sourceIdentity(s.source) === sourceId);
      if (
        !source ||
        !safeOwnerString(sourceId) ||
        source.skills.length > 256 ||
        source.skills.some((s) => !safeOwnerString(s))
      )
        throw invalid();
      if (!/^(?:https?:|ssh:|git:|git@)/.test(source.url) && source.url !== pathToFileURL(configured.repo).href)
        throw new SessionError(
          'APP_UNAVAILABLE',
          'This local source requires an already trusted configured checkout; no owner records another local checkout',
        );
      return source;
    };
    const clock = yield* AgentClock;
    const now = (yield* clock.now).getTime();
    for (const [id, receipt] of cache.cursors) if (receipt.expires <= now) cache.cursors.delete(id);
    const cacheDir = join(configured.stateRoot, 'source-watch');
    const base = { generation: String(generation) };
    const unavailable = (
      reason:
        | 'read-unavailable'
        | 'deadline'
        | 'cleanup-failed'
        | 'unsafe-owner-data'
        | 'result-bytes'
        | 'source-retention',
    ) => {
      const recovery = reason === 'cleanup-failed' ? { retainedCache: true } : {};
      const state =
        reason === 'result-bytes' || reason === 'source-retention' ? ('limited' as const) : ('unavailable' as const);
      switch (name) {
        case 'watchSources':
          return { ...base, ...recovery, state, reason, items: [], nextCursor: null };
        case 'inspectSourceDiff': {
          const a = args as OperationInput<'inspectSourceDiff'>;
          return {
            ...base,
            ...recovery,
            ...diffSelection(a),
            state,
            reason,
            text: '',
            nextCursor: null,
          };
        }
        case 'pinImpact':
          return {
            ...base,
            ...recovery,
            sourceId: (args as OperationInput<'pinImpact'>).sourceId,
            state,
            reason,
            fromRevision: null,
            toRevision: null,
            skills: [],
          };
        case 'draftChangelog':
          return { ...base, ...recovery, state, reason, text: '' };
      }
    };
    const diffResult = (a: OperationInput<'inspectSourceDiff'>, content: string) => Effect.gen(function* () {
      if (settingsComplaints({ value: content }).length) return unavailable('unsafe-owner-data');
      const binding = digest({ generation, desired: inspection.desired, ...diffSelection(a), content });
      const chars = Array.from(content);
      const offset = yield* Effect.try({ try: () => cursor(a.cursor, binding, chars.length), catch: stale });
      let end = offset, bytes = 0;
      const max = Math.min(32768, a.limit * 1024);
      while (end < chars.length && bytes + Buffer.byteLength(chars[end]!) <= max)
        bytes += Buffer.byteLength(chars[end++]!);
      return {
        ...base, ...diffSelection(a), state: end < chars.length ? 'limited' : 'complete',
        text: chars.slice(offset, end).join(''), nextCursor: end < chars.length ? next(binding, end) : null,
      };
    });
    const body = Effect.gen(function* () {
      if (name === 'watchSources') {
        const a = args as OperationInput<'watchSources'>;
        const sources = yield* Effect.try({
          try: () =>
            a.sourceIds ? [...new Set(a.sourceIds)].map(known) : declared.map((s) => known(sourceIdentity(s.source))),
          catch: (error) => (error instanceof SessionError ? error : invalid()),
        });
        const binding = digest({
          generation,
          desired: inspection.desired,
          inventory: sources.map((s) => s.source),
          sourceIds: a.sourceIds ?? null,
        });
        const receipt = a.cursor ? cache.cursors.get(a.cursor) : undefined;
        if (
          a.cursor &&
          (!receipt ||
            receipt.binding !== binding ||
            [...receipt.observed].some(([id, sha]) => cache.observations.get(id) !== sha))
        )
          return yield* Effect.fail(stale());
        const offset = receipt?.offset ?? 0;
        const reports = yield* watchSourcesWithServices(sources.slice(offset, offset + a.limit), { cacheDir });
        if (reports.some((r) => !safeReport(r))) return unavailable('unsafe-owner-data');
        const items = reports.map((r, index) => ({
          sourceId: sourceIdentity(sources[offset + index]!.source),
          status: r.status,
          fromRevision: r.baseline?.sha ?? null,
          toRevision: r.latest?.sha ?? null,
          skills: skillRows(sourceIdentity(sources[offset + index]!.source), r.skills),
          added: r.added,
          ...(r.local ? { local: localRow(sourceIdentity(r.source), r.local) } : {}),
        }));
        try {
          decodeOperationOutput('watchSources', { ...base, state: 'complete', items, nextCursor: null });
        } catch {
          return unavailable('unsafe-owner-data');
        }
        if (Buffer.byteLength(JSON.stringify(items)) > 32768) return unavailable('result-bytes');
        const observed = new Map(receipt?.observed);
        for (const [index, report] of reports.entries()) {
          if (!report.latest && !report.local) continue;
          const sha = digest({ baseline: report.baseline?.sha, latest: report.latest?.sha, local: report.local });
          if (
            cache.observations.has(sourceIdentity(sources[offset + index]!.source)) &&
            cache.observations.get(sourceIdentity(sources[offset + index]!.source)) !== sha
          )
            cache.cursors.clear();
          cache.observations.set(sourceIdentity(sources[offset + index]!.source), sha);
          observed.set(sourceIdentity(sources[offset + index]!.source), sha);
        }
        if (cache.observations.size > 256) {
          cache.observations.clear();
          cache.cursors.clear();
          return unavailable('source-retention');
        }
        const incomplete = reports.some((r) => r.status === 'unreachable' || r.status === 'baseline-missing' || r.local?.status === 'not-a-repo');
        let nextCursor: string | null = null;
        if (offset + reports.length < sources.length) {
          while (cache.cursors.size >= 32) cache.cursors.delete(cache.cursors.keys().next().value!);
          nextCursor = randomUUID();
          cache.cursors.set(nextCursor, { binding, offset: offset + reports.length, expires: now + 600000, observed });
        }
        return {
          ...base,
          state: incomplete ? 'unavailable' : 'complete',
          ...(incomplete ? { reason: 'read-unavailable' } : {}),
          items,
          nextCursor,
        };
      }
      if (name === 'pinImpact') {
        const a = args as OperationInput<'pinImpact'>;
        const source = yield* Effect.try({
          try: () => known(a.sourceId),
          catch: (error) => (error instanceof SessionError ? error : invalid()),
        });
        const affected = affectedSkills(inspection, source.source);
        if (affected.length > 256 || affected.some(skill => !safeOwnerString(skill.name))) return unavailable('unsafe-owner-data');
        const result = yield* pinImpactWithServices({ ...source, skills: [...new Set(affected.map(skill => skill.name))] }, a.revision, { cacheDir });
        return {
          ...base,
          sourceId: a.sourceId,
          state: 'complete',
          fromRevision: result.from?.sha ?? null,
          toRevision: result.to.sha,
          skills: [...new Map(affected.map(skill => {
            const skillId = `skill:${sourceIdentity(skill.source)}/${skill.name}`;
            return [skillId, { skillId, name: skill.name, status: result.skills.find(move => move.name === skill.name)!.status }] as const;
          })).values()],
        };
      }
      if (name === 'inspectSourceDiff' && 'localObservation' in args) {
        const a = args as Extract<OperationInput<'inspectSourceDiff'>, { localObservation: string }>;
        const source = yield* Effect.try({
          try: () => known(a.sourceId),
          catch: error => error instanceof SessionError ? error : invalid(),
        });
        if (!source.checkout)
          return yield* Effect.fail(new SessionError('APP_UNAVAILABLE', 'This source has no already trusted configured checkout'));
        const local = yield* watchCheckout(source.checkout);
        if (!safeLocal(local)) return unavailable('unsafe-owner-data');
        if (digest(local) !== a.localObservation) {
          cache.cursors.clear();
          return yield* Effect.fail(stale());
        }
        const skill = local.skills.find(s => `skill:${a.sourceId}/${s.name}` === a.skillId);
        if (!skill) return yield* Effect.fail(invalid());
        return yield* diffResult(a, skill.skillMd ?? '');
      }
      const choices =
        name === 'draftChangelog'
          ? (args as OperationInput<'draftChangelog'>).accepted
          : [args as Extract<OperationInput<'inspectSourceDiff'>, { fromRevision: string }>];
      const selected = yield* Effect.try({
        try: () => {
          if (new Set(choices.map((c) => c.sourceId)).size !== choices.length) throw invalid();
          return choices.map((c) => ({ ...known(c.sourceId), baseline: c.fromRevision }));
        },
        catch: (error) => (error instanceof SessionError ? error : invalid()),
      });
      const reports = yield* watchSourcesWithServices(
        selected, { cacheDir }, new Map(choices.map((c, i) => [selected[i]!.source, c.toRevision])),
      );
      if (reports.some((r) => !safeReport(r))) return unavailable('unsafe-owner-data');
      if (
        reports.some(
          (r, i) =>
            r.status === 'unreachable' ||
            r.status === 'baseline-missing' ||
            r.baseline?.sha !== choices[i]!.fromRevision ||
            r.latest?.sha !== choices[i]!.toRevision,
        )
      )
        return unavailable('read-unavailable');
      if (name === 'inspectSourceDiff') {
        const a = args as Extract<OperationInput<'inspectSourceDiff'>, { fromRevision: string }>;
        const skill = reports[0]!.skills.find((s) => `skill:${a.sourceId}/${s.name}` === a.skillId);
        if (!skill) return yield* Effect.fail(invalid());
        return yield* diffResult(a, skill.skillMd ?? '');
      }
      const accepted = (args as OperationInput<'draftChangelog'>).accepted;
      for (const [i, choice] of accepted.entries()) {
        const report = reports[i]!;
        if (
          choice.added?.some((n) => !report.added.includes(n)) ||
          choice.ignored?.some(
            (n) => !report.skills.some((s) => s.name === n && ['changed', 'removed'].includes(s.status)),
          )
        )
          return yield* Effect.fail(invalid());
      }
      const result = draftChangelog(
        reports.map((report, i) => ({ ...report, source: accepted[i]!.sourceId })),
        accepted.map((c) => ({ source: c.sourceId, revision: c.toRevision, ignored: c.ignored, added: c.added })),
      );
      if (settingsComplaints({ value: result.markdown }).length) return unavailable('unsafe-owner-data');
      if (Buffer.byteLength(result.markdown) > 32768) return unavailable('result-bytes');
      return { ...base, state: 'complete', text: result.markdown };
    });
    if (environment.env === undefined)
      return yield* Effect.fail(
        new SessionError('APP_UNAVAILABLE', 'Source inspection requires an explicitly configured process environment'),
      );
    const exit = yield* Effect.exit(
      joinedDeadline(
        body.pipe(Effect.provide(machineGit({ env: environment.env, timeoutMs: 15000, maxBytes: 1048576 }))),
        20000,
        clock.sleep,
      ),
    );
    let result: unknown;
    if (Exit.isSuccess(exit)) result = exit.value;
    else {
      const reasons = exit.cause.reasons;
      const error = reasons.find((r) => r._tag === 'Fail' && r.error instanceof SessionError);
      const cleanup = reasons.some(
        (r) =>
          r._tag === 'Die' ||
          (r._tag === 'Fail' &&
            typeof r.error === 'object' &&
            r.error !== null &&
            '_tag' in r.error &&
            String(r.error._tag) === 'SourceCleanupFailed'),
      );
      if (!cleanup && error && error._tag === 'Fail') return yield* Effect.fail(error.error as SessionError);
      result = unavailable(
        cleanup
          ? 'cleanup-failed'
          : reasons.some(
                (r) =>
                  r._tag === 'Fail' &&
                  typeof r.error === 'object' &&
                  r.error !== null &&
                  '_tag' in r.error &&
                  r.error._tag === 'SourceDeadline',
              )
            ? 'deadline'
            : 'read-unavailable',
      );
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 65536) result = unavailable('result-bytes');
    return yield* Effect.try({
      try: () => decodeOperationOutput(name, result),
      catch: () => new SessionError('OVERSIZED', 'Source observation contains unsupported owner data'),
    });
  });
