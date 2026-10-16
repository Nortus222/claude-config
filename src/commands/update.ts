import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Layer, Stream } from 'effect';
import { decodeOverrides, loadProfile, nodeFiles, parseSkillsManifest, type DesiredConfig, type Target } from '@nortuscc/profile-engine';
import {
  authorDigest, bindAuthorCheckout, canonical, executeUpdateManifest, installedSkillNames, prepareUpdateManifest, readSkillLockEvidence, stateStore, UpdateManifestRefused, validateAuthorBinding, backupsForRun, execute, Fs, inspectUpdates, MachinePaths, MANIFEST_FILE, nodeFs, nodeProcesses,
  LaunchFailed, Processes, pathsFromEnvironment, plan, readSkillLock, selectAll, short, SKILL_STEP, skillNamesOf, skillsDomain,
  type PreparedAuthorEdit, type Observed, type RepoNotFound, type SkillLock,
} from '@nortuscc/machine';
import { checkoutGroups, decodeSyncState, SyncStore, syncStore, type Holds } from '@nortuscc/sync';
import { composeHeld } from '../machine.ts';
import { formatRow, labelWidth, section } from '../report.ts';
import { select } from '../select.ts';
import { parseTarget, selectedTargets } from '../targets.ts';

const NEEDS_NAMES = '--add needs a comma-separated list of skill names';

export type UpdateFlags = { check: boolean; yes: boolean; prune: boolean; add: string[]; error: string | null };

export function parseFlags(args: string[]): UpdateFlags {
  const out: UpdateFlags = { check: false, yes: false, prune: false, add: [], error: null };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;

    if (arg === '--check') { out.check = true; continue; }
    if (arg === '--yes') { out.yes = true; continue; }
    if (arg === '--prune') { out.prune = true; continue; }

    // No bare --add: adopting a whole repo is exactly what a curated skill set
    // is not, so the names have to be said out loud. Both spellings funnel
    // through one place so neither can grow its own rule.
    let names: string | null = null;
    if (arg.startsWith('--add=')) {
      names = arg.slice('--add='.length);
    } else if (arg === '--add') {
      const next = args[i + 1];
      // A following flag is not a name list — `--add --prune` is a missing
      // argument, not an adoption of a skill called "--prune".
      if (next && !next.startsWith('-')) { names = next; i += 1; }
    } else {
      // --check/--yes/--prune already `continue`d above, so anything reaching
      // here is neither one of those nor an --add spelling: an unknown flag.
      out.error = `unknown option(s) for update: ${arg}`;
      return out;
    }

    out.add = (names ?? '').split(',').filter(Boolean);
    if (out.add.length === 0) { out.error = NEEDS_NAMES; return out; }
  }

  if (out.check && (out.yes || out.prune || out.add.length)) {
    out.error = '--check is mutually exclusive with --yes, --add and --prune (it reports only)';
  }
  return out;
}

const inState = (items: ReadonlyArray<Observed>, state: string) => items.filter((i) => i.state === state);
const labels = (items: ReadonlyArray<Observed>) => items.map((i) => i.label).join(', ');

// 1 when the run failed, the machine could not be read, a gone skill was left in place, a skill was
// left off its pin, or a source could not be checked.
export function exitCode(input: {
  items: ReadonlyArray<Observed>; failed: boolean; prunedNames?: ReadonlyArray<string>; probeErrors?: ReadonlyArray<string>;
  repinnedNames?: ReadonlyArray<string>;
}): 0 | 1 {
  if (input.failed || (input.probeErrors?.length ?? 0) > 0) return 1;
  const pruned = new Set(input.prunedNames ?? []);
  const goneLeft = inState(input.items, 'gone').filter((i) => !pruned.has(i.label));
  const repinned = new Set(input.repinnedNames ?? []);
  const offPinLeft = inState(input.items, 'off-pin').filter((i) => !repinned.has(i.label));
  if (goneLeft.length > 0 || offPinLeft.length > 0 || inState(input.items, 'unknown').length > 0) return 1;
  return 0;
}

// Counts first, in the aggregate style status.mjs uses, then a detail line per
// outdated or off-pin skill — listing 24 up-to-date skills individually would bury the
// two that matter.
export function reportLines(items: ReadonlyArray<Observed>): string[] {
  const current = inState(items, 'current');
  const outdated = inState(items, 'outdated');
  const offPin = inState(items, 'off-pin');
  const gone = inState(items, 'gone');
  const unknown = inState(items, 'unknown');
  const local = inState(items, 'local');
  const available = inState(items, 'available');

  const lines: string[] = [];
  if (current.length) lines.push(formatRow('current', String(current.length), ''));
  if (outdated.length) lines.push(formatRow('outdated', String(outdated.length), labels(outdated)));
  if (offPin.length) lines.push(formatRow('off-pin', String(offPin.length), labels(offPin)));
  if (gone.length) lines.push(formatRow('gone', String(gone.length), labels(gone)));
  if (unknown.length) lines.push(formatRow('unreachable', String(unknown.length), labels(unknown)));
  if (local.length) lines.push(formatRow('local', String(local.length), labels(local)));
  if (available.length) lines.push(formatRow('available', String(available.length), labels(available)));
  if (!lines.length) lines.push(formatRow('skills', 'none', 'nothing installed to check'));

  const detailed = [...outdated, ...offPin];
  if (detailed.length) {
    lines.push('');
    // Skill names are arbitrary, so the column has to be sized to the batch —
    // `setup-matt-pocock-skills` is 24 characters and would otherwise push its
    // own state column eight past everyone else's.
    const width = labelWidth(detailed.map((o) => o.label));
    for (const o of detailed) lines.push(formatRow(o.label, o.state, `${o.note}  ${o.group}`, width));
  }
  // A count row alone leaves a `gone` skill with no next step, and `Run:
  // nortuscc update` excludes `gone` skills by construction. The footer names
  // its skills rather than saying "them": it prints directly below the
  // outdated and off-pin detail rows, so a pronoun would read as referring
  // to those. It points at `update --prune` (backed up, manifest kept in
  // step), not a manual remove followed by `capture`, whose shrink guard
  // would refuse.
  // `--check` mode still needs it, since no picker opens there.
  if (gone.length) {
    lines.push(
      '',
      `  gone upstream: ${labels(gone)}`,
      '  nothing can update these. Run: nortuscc update --prune   to remove them (with a backup)',
    );
  }
  return lines;
}

export type Choice = { key: string; group: 'update' | 'remove' | 'add'; label: string; note: string; checked: boolean };

// Picker rows keyed by item key. Outdated and off-pin are checked by default: refreshing
// what you already have, or putting it back at its pin, is what the command is for.
// Removing and adopting are opt-in.
export function choices(items: ReadonlyArray<Observed>, seeded: ReadonlySet<string>): Choice[] {
  const row = (item: Observed, group: Choice['group'], checked: boolean): Choice => ({
    key: item.key, group, label: item.label, note: `${item.note}  ${item.group}`, checked: checked || seeded.has(item.key),
  });
  return [
    ...inState(items, 'outdated').map((i) => row(i, 'update', true)),
    ...inState(items, 'off-pin').map((i) => row(i, 'update', true)),
    ...inState(items, 'gone').map((i) => row(i, 'remove', false)),
    ...inState(items, 'available').map((i) => row(i, 'add', false)),
  ];
}

// Flags pre-check rows rather than bypassing the picker, so the same values
// drive the interactive and the scripted paths.
export function seedKeys(items: ReadonlyArray<Observed>, flags: { add: string[]; prune: boolean }): Set<string> {
  const seeded = new Set<string>();
  if (flags.prune) for (const g of inState(items, 'gone')) seeded.add(g.key);
  const wanted = new Set(flags.add);
  for (const a of inState(items, 'available')) if (wanted.has(a.label)) seeded.add(a.key);
  return seeded;
}

export type UpdateDeps = {
  // May fail to build (no checkout recorded); it is built only after the arguments parse.
  layer: Layer.Layer<Fs | MachinePaths | Processes, RepoNotFound>;
  select: typeof select;
  isTTY: boolean;
  signal?: AbortSignal;
};

const write = (text: string) => { process.stdout.write(text); };

// Resumes once the signal fires (at once if it already has).
const whenAborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void);
    const onAbort = () => resume(Effect.void);
    signal.addEventListener('abort', onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', onAbort));
  });

const hashOf = (lock: SkillLock, name: string): string | null => {
  const meta = lock.skills[name];
  if (typeof meta !== 'object' || meta === null) return null;
  const hash = (meta as Record<string, unknown>).skillFolderHash;
  return typeof hash === 'string' && hash ? hash : null;
};

const messageOf = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && 'path' in error && 'reason' in error) {
    return `could not read ${String(error.path)}: ${String(error.reason)}`;
  }
  return String(error);
};

export async function runUpdate(allArgs: string[], deps: UpdateDeps): Promise<number> {
  const { target, rest: args, error: targetError } = parseTarget(allArgs);
  if (targetError) {
    console.error(`nortuscc: ${targetError}`);
    return 2;
  }

  const flags = parseFlags(args);
  if (flags.error) {
    console.error(`nortuscc: ${flags.error}`);
    console.error('Usage: nortuscc update [--check] [--yes] [--add <names>] [--prune]');
    return 2;
  }

  // Inspects and acts on the configuration `loadDesired` answers, read from MachinePaths.repo. With
  // `holds`, that repo is the composed copy, and `holds.checkout` is the git checkout.
  const act = <E>(loadDesired: Effect.Effect<DesiredConfig, E>, holds: { checkout: string; held: Holds } | null, acceptedChoices: { path: string; bytes: Uint8Array | undefined }) => Effect.gen(function* () {
    const inspection = Effect.gen(function* () {
      const desired = yield* loadDesired;
      if (desired.issues.some(issue => issue.layer === 'machine')) return yield* Effect.fail(new Error('Skill addition choices are invalid; repair overrides.json before updating'));
      return { desired, ...(yield* inspectUpdates(desired)) };
    });
    // Git children run in their own process group, so the terminal's Ctrl-C never reaches them:
    // the signal interrupts the check, which kills them.
    const inspected = deps.signal
      ? yield* Effect.raceFirst(inspection, Effect.as(whenAborted(deps.signal), undefined))
      : yield* inspection;
    if (inspected === undefined || deps.signal?.aborted) {
      write('\ncancelled\n');
      return 1;
    }
    const { desired, probeErrors } = inspected;
    // The composed setup lacks a skill held absent, so its source still offers it as `available`;
    // dropping those keeps --add and the picker from adopting what the person chose not to have.
    const items = holds
      ? inspected.items.filter((i) => !(i.state === 'available' && `skill:${i.group}/${i.label}` in holds.held))
      : inspected.items;
    for (const message of probeErrors) console.error(message);
    write('\n' + section('update', reportLines(items)));

    const available = inState(items, 'available');
    // seedKeys silently drops an --add name it cannot match (a typo, a name
    // already installed, a name from a different repo) — right for the picker,
    // but left unreported a scripted adoption that did nothing would look
    // identical to one that worked. Named once, here, so every path below
    // reports it the same way.
    const unmatchedAdd = flags.add.filter((name) => !available.some((a) => a.label === name));
    if (unmatchedAdd.length) {
      // A name can also go unmatched because the source that would have offered
      // it could never be reached at all, so say so instead of guessing at a typo.
      const unreachableSources = [...new Set(inState(items, 'unknown').map((u) => u.group))];
      const reason = unreachableSources.length
        ? `already installed, misspelled, not offered by a known source, or from a source that could not`
          + ` be reached (${unreachableSources.join(', ')})`
        : 'already installed, misspelled, or not offered by a known source';
      write(`\n--add named skill(s) not found upstream (${reason}): ${unmatchedAdd.join(', ')}\n`);
    }
    // A scripted run that named a skill and adopted none of what it asked for
    // is not a success just because nothing else went wrong.
    const addFailed = unmatchedAdd.length > 0;

    if (flags.check) {
      if (inState(items, 'outdated').length || inState(items, 'off-pin').length) write('\nRun: nortuscc update\n');
      return exitCode({ items, failed: false, probeErrors });
    }

    const rows = choices(items, seedKeys(items, flags));
    if (rows.length === 0) return exitCode({ items, failed: addFailed, probeErrors });

    let keys: string[];
    if (flags.yes) {
      // Scripted: take the defaults the picker would have shown, which is every
      // outdated and off-pin skill plus whatever the flags seeded.
      keys = rows.filter((r) => r.checked).map((r) => r.key);
    } else {
      const picked = yield* Effect.promise(() => deps.select(rows, { title: 'choose what to adopt, refresh and prune', isTTY: deps.isTTY }));
      if (picked === null) {
        // select answers null both when cancelled and when there is no terminal;
        // only the caller knows which, and only the latter is a refusal.
        if (!deps.isTTY) {
          console.error('\nnortuscc: no terminal to choose on. Re-run with --yes to take the defaults,\n  or with --check to report only.');
          return 2;
        }
        write('nothing selected\n');
        return exitCode({ items, failed: addFailed });
      }
      keys = picked as string[];
    }

    const report = { desired, items, probeErrors };
    const selection = { ...selectAll, targets: selectedTargets(target) as Target[], only: keys };
    const p = plan('update', report, selection, [skillsDomain]);
    const additionNames = new Set(desired.skills.filter(skill => skill.targets !== undefined).map(skill => skill.name));
    const blockedAdditions = p.skipped.filter(item => keys.includes(item.key) && additionNames.has(item.key.slice('skill:'.length)));
    for (const skipped of blockedAdditions) write(`\n${skipped.key}: ${skipped.reason}. Use resolveSkillCandidate, previewChange(addSkill), then applyChange.\n`);
    if (p.steps.length === 0) {
      write('nothing selected\n');
      return exitCode({ items, failed: addFailed || blockedAdditions.length > 0 });
    }

    const before = yield* readSkillLock;
    const outcomes = new Map<string, 'ok' | 'failed' | 'cancelled'>();
    let anyFailed = false;
    let cancelled = false;
    let backups: string | undefined;
    // Reported after the run, once the manifest has reached the checkout.
    let manifestNote: string | undefined;

    const paths = yield* MachinePaths; const fs = yield* Fs;
    const authorRepo = holds?.checkout ?? paths.repo;
    const syncPath = join(paths.stateRoot,'sync.json');
    const syncBytes = yield* fs.readBytes(syncPath);
    const acceptedHolds = yield* decodeSyncState(syncBytes === undefined ? undefined : new TextDecoder('utf-8',{ fatal:true }).decode(syncBytes),syncPath);
    if (canonical(acceptedHolds) !== canonical(holds?.held ?? {})) return yield* Effect.fail(new Error('Sync choices changed; inspect and select again'));
    const author = p.steps.some(step => step.key === SKILL_STEP.manifest) ? yield* bindAuthorCheckout({ ...paths,repo:authorRepo },[MANIFEST_FILE]) : undefined;
    const authorGroups = author ? parseSkillsManifest(yield* fs.readText(join(author.realCheckout,MANIFEST_FILE))) : [];
    const heldManifestGroups = checkoutGroups([],authorGroups,acceptedHolds); const heldItemIds = Object.keys(acceptedHolds);
    const native = yield* readSkillLockEvidence; const installed = yield* installedSkillNames;
    let prepared: PreparedAuthorEdit | undefined; let refusal: string | undefined;
    if (author) {
      const result = yield* Effect.result(prepareUpdateManifest({ author,desired,report,selected:p,heldManifestGroups,heldItemIds }));
      if (result._tag === 'Success') prepared = result.success;
      else if (result.failure instanceof UpdateManifestRefused) refusal = result.failure.reason;
      else return yield* Effect.fail(result.failure);
    }
    const revalidateChoices = Effect.gen(function* () {
      if (authorDigest(yield* fs.readBytes(acceptedChoices.path)) !== authorDigest(acceptedChoices.bytes)) return yield* Effect.fail(new Error('Skill addition choices changed; inspect and select again'));
      if (authorDigest(yield* fs.readBytes(syncPath)) !== authorDigest(syncBytes)) return yield* Effect.fail(new Error('Sync choices changed; inspect and select again'));
    });
    const processes = yield* Processes;
    const guardedProcesses: Processes['Service'] = { run: command => Effect.flatMap(
      revalidateChoices.pipe(Effect.mapError(() => new LaunchFailed({ cmd: command.cmd, reason: 'Machine choices changed; inspect and select again' }))),
      () => processes.run(command),
    ) };
    const updateDomain = { ...skillsDomain,run:(step:import('@nortuscc/machine').Step,input:import('@nortuscc/machine').MachineReport) => Effect.gen(function* () {
      yield* revalidateChoices;
      if (step.key !== SKILL_STEP.manifest) return yield* skillsDomain.run(step,input);
      if (author) yield* validateAuthorBinding(author);
      if (!prepared) return { ok:true,note:`left alone — ${refusal ?? 'no author change selected'}` };
      const result = yield* executeUpdateManifest({ edit:prepared,desired,selected:p,heldManifestGroups,heldItemIds },deps.signal ?? new AbortController().signal,
        { pending:() => Effect.void,committed:() => Effect.void },revalidateChoices);
      const count = prepared.documents.length ? parseSkillsManifest(prepared.documents[0]!.text).reduce((count,group) => count+group.skills.length,0) : authorGroups.reduce((count,group) => count+group.skills.length,0);
      return { ok:!result.remainingPaths.length,note:`written — ${count} skill(s)` };
    }) };
    const checkpoint = (event: Extract<import('@nortuscc/machine').Progress,{ type:'started' | 'finished' }>) => Effect.gen(function* () {
      if (event.type !== 'started' || event.index !== 0) return;
      yield* revalidateChoices;
      if (author) yield* validateAuthorBinding(author);
      if (authorDigest((yield* readSkillLockEvidence).bytes) !== authorDigest(native.bytes) || canonical(yield* installedSkillNames) !== canonical(installed)) return yield* Effect.fail(new Error('Machine update inputs changed; inspect and select again'));
    });
    yield* Stream.runForEach(execute(p, report, [updateDomain], { signal: deps.signal,checkpoint }), (event) => Effect.sync(() => {
      switch (event.type) {
        case 'started': {
          const key = event.step.key;
          if (key === SKILL_STEP.remove || key === SKILL_STEP.update || key.startsWith(SKILL_STEP.install)) write(`\n${event.step.summary}\n`);
          return;
        }
        case 'finished':
          outcomes.set(event.key, event.outcome);
          if (event.outcome === 'failed') anyFailed = true;
          if (event.key === SKILL_STEP.manifest && event.outcome !== 'ok') manifestNote = `failed — ${event.note ?? event.outcome}`;
          if (event.outcome !== 'ok') {
            if (event.note) write(`\n${event.key}: ${event.note}\n`);
          } else if (event.key === SKILL_STEP.expose && event.note) {
            write(`\n${event.note}\n`);
          } else if (event.key === SKILL_STEP.manifest) {
            manifestNote = event.note;
          }
          return;
        case 'done':
          backups = event.backups;
          return;
        case 'cancelled':
          backups = event.backups;
          cancelled = true;
          write(`\ncancelled — not run: ${event.remaining.join(', ')}\n`);
      }
    })).pipe(Effect.provide(backupsForRun()), Effect.provideService(Processes, guardedProcesses));

    const manifestWritten = manifestNote?.startsWith('written') ?? false;
    if (manifestNote !== undefined) {
      write(`\nskills-manifest.txt ${manifestNote}\n`);
      if (manifestWritten) write('Run: nortuscc push -m "..."   to share it\n');
    }

    if (backups) write(`\nbacked up -> ${backups}\n`);

    // The closing report describes what was observed: it re-reads the lock
    // rather than trusting that a requested update moved anything.
    const after = yield* readSkillLock;
    const ran = (key: string) => outcomes.get(key) === 'ok' || outcomes.get(key) === 'failed';
    const updateStep = p.steps.find((s) => s.key === SKILL_STEP.update);
    const updated = updateStep && ran(updateStep.key) ? skillNamesOf(updateStep) : [];
    const moved = updated
      .map((name) => ({ name, from: hashOf(before, name), to: hashOf(after, name) }))
      .filter((m) => m.from !== null && m.to !== null && m.to !== m.from);
    const width = labelWidth(moved.map((m) => m.name));
    // An update ran but the lock shows no verifiable move — nothing changed, or
    // no hash was ever recorded to compare against. Silence would read as if the
    // update never happened.
    const unmoved = updated.length > 0 && moved.length === 0;

    const removeStep = p.steps.find((s) => s.key === SKILL_STEP.remove);
    const removed = removeStep && ran(removeStep.key) ? skillNamesOf(removeStep) : [];
    const removeOk = removeStep !== undefined && outcomes.get(removeStep.key) === 'ok';
    // Each source is its own installer call, so an add fails only for the source that failed.
    // An off-pin skill was already installed, so its successful install reads `reinstalled`.
    const offPinNames = new Set(inState(items, 'off-pin').map((i) => i.label));
    const installSteps = p.steps.filter((s) => s.key.startsWith(SKILL_STEP.install) && ran(s.key));
    const addRows = installSteps.flatMap((s) => {
      const source = s.key.slice(SKILL_STEP.install.length);
      const ok = outcomes.get(s.key) === 'ok';
      return skillNamesOf(s).map((name) =>
        (ok ? formatRow(name, offPinNames.has(name) ? 'reinstalled' : 'added', source)
          : formatRow(name, 'failed', `${source} — install failed, see output above`)));
    });
    const repinned = installSteps.filter((s) => outcomes.get(s.key) === 'ok')
      .flatMap((s) => skillNamesOf(s)).filter((name) => offPinNames.has(name));

    write('\n' + section('done', [
      ...moved.map((m) => formatRow(m.name, 'updated', `${short(m.from)} -> ${short(m.to)}`, width)),
      ...(unmoved ? [formatRow('skills', 'unchanged', 'the updater reported no change')] : []),
      ...removed.map((n) => formatRow(n, removeOk ? 'removed' : 'failed', removeOk ? '' : 'remove failed — see output above')),
      ...addRows,
    ]));

    if (anyFailed) {
      write(backups
        ? '\nSomething failed above. The backup is listed above.\n'
        : '\nSomething failed above. No backup was made — nothing existed to preserve.\n');
    }

    // Gone skills count as handled only once removed, off-pin ones only once reinstalled at their pin.
    return exitCode({
      items, failed: anyFailed || addFailed || cancelled || blockedAdditions.length > 0, prunedNames: removeOk ? removed : [], repinnedNames: repinned,
    });
  });

  const program = Effect.gen(function* () {
    const paths = yield* MachinePaths;
    const fs = yield* Fs;
    const choicePath = join(paths.stateRoot, 'overrides.json');
    const choiceBytes = yield* fs.readBytes(choicePath);
    const document = yield* Effect.try({
      try: () => choiceBytes === undefined ? { version: 2 } : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(choiceBytes)),
      catch: () => new Error('Skill addition choices are invalid; repair overrides.json before updating'),
    });
    const saved = decodeOverrides(document, choicePath);
    if (saved.issues.length) return yield* Effect.fail(new Error('Skill addition choices are invalid; repair overrides.json before updating'));
    // Legacy update ignores other overrides. Related skill choices still belong to addition resolution.
    const names = new Set(saved.value.skillAdditions?.map(skill => skill.name));
    const overrides = { ...saved, value: { skillAdditions: saved.value.skillAdditions,
      skills: Object.fromEntries(Object.entries(saved.value.skills ?? {}).filter(([name]) => names.has(name))) } };
    const choices = { path: choicePath, bytes: choiceBytes };
    // An invalid sync.json fails the run: SyncStateInvalid carries the message.
    const held = yield* Effect.gen(function* () {
      return yield* (yield* SyncStore).read;
    }).pipe(Effect.provide(syncStore));
    // No requireValid: an integrations.json issue must not block `update`.
    if (Object.keys(held).length === 0) return yield* act(loadProfile(paths.repo, { overrides }).pipe(Effect.provide(nodeFiles)), null, choices);
    // Held documents keep the same addition intent and publication provenance as ordinary updates.
    return yield* Effect.scoped(Effect.gen(function* () {
      const snapshot = yield* composeHeld({ checkout: paths.repo, held, overrides });
      return yield* act(Effect.succeed(snapshot.desired), { checkout: paths.repo, held }, choices).pipe(
        Effect.provideService(MachinePaths, { ...paths, repo: snapshot.repo }),
      );
    }));
  });

  return Effect.runPromise(program.pipe(
    Effect.provide(stateStore),
    Effect.provide(deps.layer),
    Effect.catch((error: unknown) => Effect.sync(() => {
      console.error(`nortuscc: ${messageOf(error)}`);
      return 1;
    })),
  ));
}

// The checkout this file belongs to: where a machine with no recorded checkout runs from.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export async function run(args: string[]): Promise<number> {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.on('SIGINT', onInterrupt);
  try {
    const paths = Layer.effect(MachinePaths, pathsFromEnvironment({
      env: process.env, home: homedir(), platform: process.platform, fallbackRepo: REPO_ROOT, warn: console.error,
    }));
    return await runUpdate(args, {
      layer: Layer.mergeAll(paths, nodeFs, nodeProcesses()),
      select,
      isTTY: Boolean(process.stdin.isTTY),
      signal: controller.signal,
    });
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}
