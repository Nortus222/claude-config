import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Effect, Layer, Semaphore } from 'effect';
import {
  decodeHosted, IdSchema, normalizeRepoUrl, RepoUrlSchema, SyncRevisionSchema, type SyncRevision,
} from '@nortuscc/hosted-protocol';
import {
  Backups, backupsForRun, canonical, FETCH_TIMEOUT_MS, Fs, LaunchFailed, machinePaths, nodeFs, nodeProcesses, OverridesStore, overridesStore, parseState, Processes, STALL_LIMIT_ARGS,
  type Decision, type MachinePathsValue,
} from '@nortuscc/machine';
import type { Input, MachineOverrides } from '@nortuscc/profile-engine';
import { fetchFollowedMain, privateFollowedRepository } from './followed-repository.ts';
import { gitAuthArgs } from './git-auth.ts';
import type { FollowedProfile } from './followed.ts';
import { commitDocuments, commitDocumentsCache, originUrl, revParse, type CommitDocumentsCache } from './git.ts';
import { diffItems, itemValues, parseItemId } from './items.ts';
import { patchItem } from './patch.ts';
import { overrideOf } from './plan.ts';
import { SetupsStore, setupsStore } from './setups.ts';
import { snapshotFromDocuments } from './snapshots.ts';
import { droppedOnSwitch, retainedOverrides } from './resolved-items.ts';
import {
  RevisionMismatch, RevisionUnavailable, SetupSource, type AppliedEvidence, type HostedBaseline, type Revision,
} from './source.ts';
import { SyncStore, syncStore } from './store.ts';
import { desiredOfDocuments, hasProfile, type Documents } from './documents.ts';

type Services = Fs | Processes | SetupsStore | OverridesStore | SyncStore | CommitDocumentsCache;
const unavailable = (revision: Revision, reason: string) => Effect.fail(new RevisionUnavailable({ revision, reason }));
const mismatch = (revision: Revision, reason: string) => Effect.fail(new RevisionMismatch({ revision, reason }));
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const hostedBaselineRelative = (accountId: string, repoUrl: string, setupId: string): string =>
  join('agent', 'baselines', accountId, hash(normalizeRepoUrl(repoUrl)), `${setupId}.json`);

// HTTP records are untrusted metadata. Only explicit local account/repository consent followed
// by exact remote tag and recomputed item verification authorizes these snapshots.
export const hostedSetupSourceLayer = (paths: MachinePathsValue, options: {
  readonly accountId: string;
  readonly currentAccountId: Effect.Effect<string | null, unknown>;
  readonly setupId: string;
  readonly repoUrl: string;
  readonly profile?: string;
  // Runtime supplies only the durable offered range, after recovering the client's projections.
  readonly records: Effect.Effect<ReadonlyArray<SyncRevision>, unknown>;
  readonly processes?: Layer.Layer<Processes>;
  readonly now?: () => Date;
  // A followed selection owns its clone independently of the legacy CLI checkout/account.
  readonly followed?: FollowedProfile;
}): Layer.Layer<SetupSource> => {
  const profile = options.followed?.profile ?? options.profile;
  const valuesOf = (documents: Documents) => itemValues(documents, profile);
  const patch = (head: Documents, id: string, held: Documents) => patchItem(head, id, held, profile);
  const now = options.now ?? (() => new Date());
  const repoIdentity = normalizeRepoUrl(options.repoUrl);
  // Identity-only host/path references need an explicit transport before reaching Git.
  const transport = /^(?:https|ssh):\/\//.test(options.repoUrl) || options.repoUrl.startsWith('git@')
    ? options.repoUrl : `https://${options.repoUrl}`;
  const repoKey = hash(repoIdentity);
  const scope = hash([options.accountId, options.setupId, repoIdentity]);
  const baselineRelative = hostedBaselineRelative(options.accountId, options.repoUrl, options.setupId);
  const baselinePath = join(paths.stateRoot, baselineRelative);
  const clone = join(paths.stateRoot, 'agent', 'checkouts', options.accountId, repoKey, options.setupId);
  const hooks = join(paths.stateRoot, 'agent', 'empty-hooks');
  const verifiedRelative = join('agent', 'follow', `${scope}.json`);
  const verifiedRecords = join(paths.stateRoot, verifiedRelative);
  const snapshotsRoot = join(paths.stateRoot, 'agent', 'hosted', options.accountId, repoKey, options.setupId);
  const git = (repo: string, args: ReadonlyArray<string>) => Processes.use((p) => p.run({ cmd: 'git', args, cwd: repo, output: 'capture', stderr: 'capture' }));

  const consent = Effect.gen(function* () {
    yield* Effect.try({ try: () => {
      decodeHosted(IdSchema, options.accountId); decodeHosted(IdSchema, options.setupId); decodeHosted(RepoUrlSchema, options.repoUrl);
    }, catch: () => new RevisionUnavailable({ revision: 'HEAD', reason: 'invalid hosted source identity' }) });
    const active = yield* options.currentAccountId.pipe(Effect.catch(() => unavailable('HEAD', 'active account unavailable')));
    if (active !== options.accountId) return yield* unavailable('HEAD', 'the active account changed');
    if (options.followed) return { checkout: null };
    const setups = yield* (yield* SetupsStore).read;
    const entry = setups?.find((s) => s.accountId === options.accountId && s.setupId === options.setupId && s.repoUrl !== null && normalizeRepoUrl(s.repoUrl) === repoIdentity);
    if (!entry) return yield* unavailable('HEAD', 'the hosted setup is not trusted for this account and repository');
    return entry;
  });

  const repository = Effect.gen(function* () {
    const entry = yield* consent;
    if (options.followed) return { repo: yield* privateFollowedRepository(paths, options.followed), linked: false };
    const repo = entry.checkout ?? clone;
    const fs = yield* Fs;
    const origin = entry.checkout === null
      ? git(repo, ['--git-dir=.', 'remote', 'get-url', 'origin']).pipe(Effect.map(({ code, stdout }) => code === 0 && stdout.trim() !== '' ? stdout.trim() : undefined))
      : originUrl(repo);
    if (entry.checkout === null) {
      const marker = join(repo, '.nortuscc-hosted');
      if (!(yield* fs.exists(repo))) {
        yield* consent;
        yield* fs.writeTextAtomic(marker, `${scope}\n`);
      }
      if ((yield* fs.readText(marker)) !== `${scope}\n`) return yield* unavailable('HEAD', 'private repository is not owned by this source');
      if ((yield* origin) === undefined) {
        // Retry only source-owned empty initialization, never repair another repository.
        const names = yield* fs.list(repo);
        const allowed = new Set(['.nortuscc-hosted', 'HEAD', 'config', 'description', 'hooks', 'info', 'objects', 'refs', 'branches']);
        const remotes = yield* git(repo, ['--git-dir=.', 'remote']);
        const refs = yield* git(repo, ['--git-dir=.', 'for-each-ref', '--format=%(refname)']);
        if (names?.some((name) => !allowed.has(name)) || remotes.stdout.trim() !== '' || refs.stdout.trim() !== '') return yield* unavailable('HEAD', 'private repository has unexpected initialization state');
        // Bare init and fetch avoid checking out or running repository-supplied code.
        if ((yield* git(repo, ['init', '--quiet', '--bare'])).code !== 0) return yield* unavailable('HEAD', 'private repository initialization failed');
        if ((yield* git(repo, ['remote', 'add', 'origin', transport])).code !== 0) return yield* unavailable('HEAD', 'private origin initialization failed');
      }
    }
    const configured = yield* origin;
    if (configured === undefined || normalizeRepoUrl(configured) !== repoIdentity) return yield* unavailable('HEAD', 'origin is not the trusted repository');
    return { repo, linked: entry.checkout !== null };
  });

  const records = Effect.gen(function* () {
    const values = yield* options.records.pipe(Effect.catch(() => options.followed
      ? Fs.use(fs => fs.readText(verifiedRecords)).pipe(Effect.flatMap(text => text === undefined
        ? unavailable('HEAD', 'no previously verified hosted revision')
        : Effect.try({ try: () => JSON.parse(text) as ReadonlyArray<SyncRevision>, catch: () => new RevisionUnavailable({ revision: 'HEAD', reason: 'verified metadata is invalid' }) })))
      : unavailable('HEAD', 'hosted revision metadata unavailable')));
    return yield* Effect.try({ try: () => {
      const decoded = values.map((r) => decodeHosted(SyncRevisionSchema, r));
      if (decoded.length === 0 || decoded.some((r, i) => r.setupId !== options.setupId || r.number !== i + 1)) throw new Error();
      return decoded;
    }, catch: () => new RevisionUnavailable({ revision: 'HEAD', reason: 'hosted revision history is incomplete or invalid' }) });
  });

  // Fetch every contributing tag once in ascending order. A matching record-specific ref is
  // written only after tag provenance and the diff are proven. Object existence alone is unused.
  const verified = (repo: string, range: ReadonlyArray<SyncRevision>) => Effect.gen(function* () {
    const documents = new Map<string, Documents>();
    let previous: Documents = {};
    for (const record of range) {
      const verifiedRef = `refs/nortuscc/hosted/${scope}/verified/${record.number}-${hash(record)}`;
      const fetchedRef = `refs/nortuscc/hosted/${scope}/candidate/${record.number}`;
      const fetched = yield* Processes.use((p) => p.run({
        cmd: 'git', args: [...(options.followed ? gitAuthArgs(hooks) : []), '-c', 'credential.interactive=never', ...STALL_LIMIT_ARGS, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', transport, `+refs/tags/${record.tag}:${fetchedRef}`],
        cwd: repo, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }, output: 'capture', stderr: 'capture',
      })).pipe(Effect.timeoutOption(FETCH_TIMEOUT_MS), Effect.map((result) => result._tag === 'Some' && result.value.code === 0), Effect.catchTag('LaunchFailed', () => Effect.succeed(false)));
      const sha = yield* revParse(repo, fetched ? fetchedRef : verifiedRef);
      if (sha === undefined) return yield* unavailable(record, 'the tag is unavailable and has no previously verified cache');
      if (sha !== record.commitSha) return yield* mismatch(record, 'trusted repository tag does not match its recorded commit');
      const current = yield* commitDocuments(repo, sha);
      if (profile !== undefined && hasProfile(current, profile) && desiredOfDocuments(current, undefined, profile).issues.length) return yield* mismatch(record, 'published profile is invalid');
      const actual = diffItems(valuesOf(previous), valuesOf(current)).map((c) => ({ id: c.itemId, kind: c.kind, change: c.before === undefined ? 'added' : c.after === undefined ? 'removed' : 'changed' }));
      const advertised = [...record.items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      if (canonical(actual) !== canonical(advertised)) return yield* mismatch(record, 'advertised items do not match the published Git diff');
      if (fetched && (yield* git(repo, ['update-ref', verifiedRef, sha])).code !== 0) return yield* unavailable(record, 'verified revision cache could not be recorded');
      documents.set(sha, current);
      previous = current;
    }
    if (options.followed) {
      const fs = yield* Fs;
      const text = JSON.stringify(range) + '\n';
      // A load of an older revision must not roll back the offline head.
      const prior = yield* fs.readText(verifiedRecords);
      const priorCount = prior === undefined ? 0 : yield* Effect.try({
        try: () => {
          const cached: unknown = JSON.parse(prior);
          if (!Array.isArray(cached)) throw new Error();
          const decoded = cached.map(r => decodeHosted(SyncRevisionSchema, r));
          if (decoded.some((r, i) => r.setupId !== options.setupId || r.number !== i + 1)) throw new Error();
          return decoded.length;
        },
        catch: () => new RevisionUnavailable({ revision: 'HEAD', reason: 'verified metadata is invalid' }),
      }).pipe(Effect.catch(() => Effect.succeed(-1)));
      if (range.length > priorCount) {
        yield* Backups.use(b => b.preserve(verifiedRecords, verifiedRelative, undefined, { private: true })).pipe(
          Effect.provide(backupsForRun(now()).pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), Layer.succeed(Fs, fs))))),
        );
        yield* fs.writeTextAtomic(verifiedRecords, text);
      }
    }
    return documents;
  });

  const readBaseline = (repo: string, linked: boolean) => Effect.gen(function* () {
    const fs = yield* Fs;
    const text = yield* fs.readText(baselinePath);
    if (text !== undefined) return yield* Effect.try({ try: (): HostedBaseline => {
      const value: unknown = JSON.parse(text);
      if (typeof value !== 'object' || value === null || !('revisionApplied' in value) || !('origins' in value)) throw new Error();
      const { revisionApplied, origins } = value;
      if (typeof revisionApplied !== 'number' || !Number.isSafeInteger(revisionApplied) || revisionApplied < 0 || typeof origins !== 'object' || origins === null || Array.isArray(origins)) throw new Error();
      if (Object.entries(origins).some(([id, commit]) => parseItemId(id) === undefined || typeof commit !== 'string' || !COMMIT.test(commit))) throw new Error();
      return { revisionApplied, origins: origins as Readonly<Record<string, string>> };
    }, catch: () => new RevisionUnavailable({ revision: 'HEAD', reason: 'hosted baseline is invalid' }) });
    const origins: Record<string, string> = {};
    const migrated = options.followed ? yield* revParse(repo, 'refs/nortuscc/migration/applied') : undefined;
    if (linked || migrated !== undefined) {
      let commit: string | undefined = migrated;
      let holds: Readonly<Record<string, string>> = migrated === undefined ? {} : yield* (yield* SyncStore).read;
      if (repo === paths.repo) {
        const recorded = yield* fs.readText(join(paths.stateRoot, 'state.json'));
        if (recorded !== undefined) {
          const state = parseState(recorded);
          if (state === undefined) return yield* unavailable('HEAD', 'local applied state is invalid');
          commit = state.applied?.commit;
        }
        holds = yield* (yield* SyncStore).read;
      }
      commit ??= yield* revParse(repo, 'HEAD');
      if (commit === undefined) return yield* unavailable('HEAD', 'linked checkout has no baseline commit');
      const docs = yield* commitDocuments(repo, commit);
      const cache = new Map([[commit, docs]]);
      let seed = docs;
      for (const id of valuesOf(docs).keys()) origins[id] = commit;
      for (const id of Object.keys(holds).sort()) {
        const held = holds[id]!;
        let heldDocs = cache.get(held);
        if (heldDocs === undefined) { heldDocs = yield* commitDocuments(repo, held); cache.set(held, heldDocs); }
        if (!hasProfile(heldDocs, profile)) continue;
        seed = patch(seed, id, heldDocs);
        if (valuesOf(heldDocs).has(id)) origins[id] = held;
        else delete origins[id];
      }
      // A root hold can also move a sibling's shared pin. Choose an existing origin with
      // that composed value, then prove the whole seed survives item-order materialization.
      const expected = valuesOf(seed);
      for (const id of Object.keys(origins)) if (!expected.has(id)) delete origins[id];
      for (const [id, value] of expected) {
        if (origins[id] !== undefined && valuesOf(cache.get(origins[id]!)!).get(id) === value) continue;
        const origin = [...cache].find(([, candidate]) => valuesOf(candidate).get(id) === value)?.[0];
        if (origin === undefined) return yield* unavailable('HEAD', 'local held seed cannot be represented by item origins');
        origins[id] = origin;
      }
      const materialized = valuesOf(yield* baselineDocuments(repo, { revisionApplied: 0, origins }, cache));
      if ([...new Set([...expected.keys(), ...materialized.keys()])].some((id) => expected.get(id) !== materialized.get(id))) return yield* unavailable('HEAD', 'local held seed cannot be preserved by item origins');
    }
    const baseline: HostedBaseline = { revisionApplied: 0, origins };
    yield* consent;
    yield* fs.writeTextAtomic(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
    return baseline;
  });

  const baselineDocuments = (repo: string, baseline: HostedBaseline, cache: Map<string, Documents>) => Effect.gen(function* () {
    let documents: Documents = {};
    for (const [id, origin] of Object.entries(baseline.origins).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      let docs = cache.get(origin);
      if (docs === undefined) { docs = yield* commitDocuments(repo, origin); cache.set(origin, docs); }
      documents = patch(documents, id, docs);
    }
    return documents;
  });

  const acceptedItems = (range: ReadonlyArray<SyncRevision>, decisions: ReadonlyArray<Decision>) => {
    const changed = new Map<string, number>();
    for (const r of range) for (const item of r.items) changed.set(item.id, r.number);
    return new Set(decisions.filter((d) => d.setupId === options.setupId && d.commit === null && d.revision !== null && d.decision === 'accept'
      && d.revision >= (changed.get(d.itemId) ?? Infinity) && range[d.revision - 1]?.items.some((i) => i.id === d.itemId)).map((d) => d.itemId));
  };

  const compose = (decisions: ReadonlyArray<Decision>, choices?: Parameters<SetupSource['Service']['effective']>[1]) => Effect.gen(function* () {
    const { repo, linked } = yield* repository;
    const range = yield* records;
    const cache = yield* verified(repo, range);
    const baseline = yield* readBaseline(repo, linked);
    const appliedDocuments = yield* baselineDocuments(repo, baseline, cache);
    const head = range[range.length - 1]!;
    const headDocuments = cache.get(head.commitSha)!;
    let documents = headDocuments;
    const accepted = acceptedItems(range, decisions);
    const overrides = choices?.overrides ?? (yield* (yield* OverridesStore).read);
    const conflicts = [...accepted].filter((id) => overrideOf(id, overrides.value) !== undefined).sort();
    // Accepted override conflicts stay visible, and use the baseline value under the override.
    const take = new Set([...accepted].filter((id) => !conflicts.includes(id)));
    for (const id of new Set([...valuesOf(documents).keys(), ...valuesOf(appliedDocuments).keys()])) {
      if (!take.has(id)) documents = patch(documents, id, appliedDocuments);
    }
    return { repo, cache, head, headDocuments, baseline, documents, appliedDocuments, overrides, conflicts, take };
  });

  const snapshot = (documents: Documents, overrides: Input<MachineOverrides>) => Effect.gen(function* () {
    yield* consent;
    const content = profile !== undefined && Object.keys(documents).length === 0 ? { [`profiles/${profile}.json`]: '{}' } : documents;
    return yield* snapshotFromDocuments({ documents: content, repoUrl: options.repoUrl, profile, stateRoot: snapshotsRoot, overrides, now: now() });
  });

  // Historical and mixed snapshots can predate an overridden item; keep its choice on disk.
  const historicalSnapshot = (documents: Documents, overrides: Input<MachineOverrides>) => {
    const dropped = droppedOnSwitch({ holds: {}, overrides: overrides.value, to: desiredOfDocuments(documents, undefined, profile) });
    return snapshot(documents, { ...overrides, value: retainedOverrides(overrides.value, dropped.overrides) });
  };

  const offeredItems = Effect.gen(function* () {
    const { repo } = yield* repository;
    const range = yield* records;
    yield* verified(repo, range);
    const offers = new Map<string, SyncRevision>();
    for (const revision of range) for (const item of revision.items) offers.set(item.id, revision);
    return [...offers].map(([itemId, revision]) => ({ itemId, revision }));
  });
  const fetch = Effect.gen(function* () {
    const { repo } = yield* repository;
    if (options.followed) yield* fetchFollowedMain(paths, repo, options.repoUrl).pipe(Effect.ignore);
    const range = yield* records;
    return { head: range[range.length - 1]! };
  });
  const load = (revision: Revision) => Effect.gen(function* () {
    const { repo } = yield* repository;
    const range = yield* records;
    if (typeof revision === 'string' || canonical(range[revision.number - 1]) !== canonical(revision)) return yield* mismatch(revision, 'revision is not the offered hosted record');
    const cache = yield* verified(repo, range.slice(0, revision.number));
    return yield* snapshot(cache.get(revision.commitSha)!, yield* (yield* OverridesStore).read);
  });
  const effective = (decisions: ReadonlyArray<Decision>, choices?: Parameters<SetupSource['Service']['effective']>[1]) => Effect.gen(function* () {
    const composed = yield* compose(decisions, choices);
    return { applied: { ...yield* historicalSnapshot(composed.appliedDocuments, composed.overrides), revision: null }, effective: yield* historicalSnapshot(composed.documents, composed.overrides), conflicts: composed.conflicts };
  });
  const current = Effect.gen(function* () {
    const { repo, linked } = yield* repository;
    const baseline = yield* readBaseline(repo, linked);
    return yield* historicalSnapshot(yield* baselineDocuments(repo, baseline, new Map()), yield* (yield* OverridesStore).read);
  });
  const baseline = Effect.gen(function* () { const { repo, linked } = yield* repository; return yield* readBaseline(repo, linked); });
  const recordApplied = (evidence: AppliedEvidence) => Effect.gen(function* () {
    const composed = yield* compose(evidence.decisions);
    if (canonical(composed.head) !== canonical(evidence.revision)) return yield* mismatch(evidence.revision, 'inspection revision is no longer the hosted head');
    const observed = new Set(evidence.observed);
    const released = new Set(evidence.released);
    const values = valuesOf(composed.documents);
    const headValues = valuesOf(composed.headDocuments);
    for (const id of new Set([...observed, ...released])) {
      if (!composed.take.has(id) || (observed.has(id) && released.has(id)) || observed.has(id) !== values.has(id) || values.get(id) !== headValues.get(id)) return yield* mismatch(evidence.revision, 'adoption evidence does not describe an accepted unconflicted effective item');
    }
    if (observed.size + released.size === 0) return;
    const origins = { ...composed.baseline.origins };
    for (const id of observed) origins[id] = composed.head.commitSha;
    for (const id of released) delete origins[id];
    // Source-wide pins can couple siblings. Refuse an origin set that would reconstruct a
    // different selected value or silently change an item without its own positive evidence.
    const next: HostedBaseline = { revisionApplied: Math.max(composed.baseline.revisionApplied, composed.head.number), origins };
    const materialized = valuesOf(yield* baselineDocuments(composed.repo, next, composed.cache));
    const prior = valuesOf(composed.appliedDocuments);
    const selected = new Set([...observed, ...released]);
    for (const id of new Set([...materialized.keys(), ...prior.keys(), ...selected])) {
      if (materialized.get(id) !== (selected.has(id) ? values.get(id) : prior.get(id))) return yield* mismatch(evidence.revision, 'selected origins cannot preserve the confirmed values independently');
    }
    if (canonical(next) === canonical(composed.baseline)) return;
    yield* consent;
    yield* Backups.use(backups => backups.preserve(baselinePath, baselineRelative, undefined, { private: true }))
      .pipe(Effect.provide(backupsForRun(now()).pipe(Layer.provide(machinePaths(paths)))));
    yield* consent;
    yield* (yield* Fs).writeTextAtomic(baselinePath, JSON.stringify(next, null, 2) + '\n');
  });

  // Guard each Git operation too: an account switch while a fetch is in flight cannot
  // continue resolving that old identity or materializing its snapshot afterwards.
  const guardedProcesses = Layer.effect(Processes, Effect.gen(function* () {
    const processes = yield* Processes;
    return { run: (command: Parameters<Processes['Service']['run']>[0]) => options.currentAccountId.pipe(
      Effect.mapError(() => new LaunchFailed({ cmd: 'git', reason: 'active account unavailable' })),
      Effect.flatMap((active) => active === options.accountId ? processes.run(command)
        : Effect.fail(new LaunchFailed({ cmd: 'git', reason: 'the active account changed' }))),
    ) };
  })).pipe(Layer.provide(options.processes ?? nodeProcesses({ inherit: 'stderr' })));

  // A cached read still resolves its commit through the guarded processes first.
  const services = Layer.mergeAll(setupsStore, overridesStore, syncStore, commitDocumentsCache).pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs, guardedProcesses)));
  return Layer.effect(SetupSource, Effect.gen(function* () {
    const context = yield* Effect.context<Services>();
    const lock = yield* Semaphore.make(1);
    const provide = <A>(effect: Effect.Effect<A, unknown, Services>) => effect.pipe(
      Effect.provideContext(context),
      Effect.mapError((error) => error instanceof RevisionMismatch || error instanceof RevisionUnavailable
        ? error : new RevisionUnavailable({ revision: 'HEAD', reason: 'hosted repository or snapshot unavailable' })),
      lock.withPermit,
    );
    const available = <A>(effect: Effect.Effect<A, unknown, Services>) => provide(effect).pipe(
      Effect.catchTag('RevisionMismatch', () => unavailable('HEAD', 'hosted baseline unavailable')),
    );
    return { setupId: options.setupId, ...(profile === undefined ? {} : { profile }), offeredItems: provide(offeredItems), trusted: available(repository.pipe(Effect.as(true))), fetch: available(fetch), load: (r: Revision) => provide(load(r)), effective: (d: ReadonlyArray<Decision>, choices?: Parameters<SetupSource['Service']['effective']>[1]) => provide(effective(d, choices)), current: available(current), baseline: available(baseline), recordApplied: (e: AppliedEvidence) => provide(recordApplied(e)) };
  })).pipe(Layer.provide(services));
};
