import { join } from 'node:path';
import { Effect } from 'effect';
import { parseSkillsManifest, type DesiredConfig, type SkillGroup } from '@nortuscc/profile-engine';
import { authorDigest, validateAuthorBinding, type AuthorBinding, executeAuthorEdit, type AuthorServices, type PreparedAuthorEdit } from './author.ts';
import type { Backups } from './backups.ts';
import type { MutationObserver } from './history.ts';
import { Fs } from './fs.ts';
import type { MachineReport, Plan } from './model.ts';
import { installedSkillNames, readSkillLockEvidence } from './skills/store.ts';
import { MANIFEST_FILE, emitManifest, manifestOutcome, updateManifestGroups } from './skills/manifest.ts';
import { SKILL_STEP, skillNamesOf } from './skills/domain.ts';

export class UpdateManifestRefused extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.reason = reason; }
}

export const prepareUpdateManifest = (input: {
  author: AuthorBinding; desired: DesiredConfig; report: MachineReport; selected: Plan; heldManifestGroups?: readonly SkillGroup[]; heldItemIds?: readonly string[];
}): Effect.Effect<PreparedAuthorEdit, unknown, AuthorServices> => Effect.gen(function* () {
  yield* validateAuthorBinding(input.author);
  const fs = yield* Fs;
  const bytes = yield* fs.readBytes(join(input.author.realCheckout, MANIFEST_FILE));
  const baseline = input.author.files.find(f => f.path === MANIFEST_FILE);
  if (!baseline || authorDigest(bytes) !== baseline.sha256) return yield* Effect.fail(new Error('Author manifest changed'));
  const before = parseSkillsManifest(bytes === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const evidence = yield* readSkillLockEvidence;
  const names = yield* installedSkillNames;
  const installed = new Set(names);
  const skills: Record<string, unknown> = { ...evidence.lock.skills };
  const pruned: string[] = [];
  for (const step of input.selected.steps) {
    if (step.key === SKILL_STEP.remove) for (const name of skillNamesOf(step)) { installed.delete(name); delete skills[name]; pruned.push(name); }
    if (step.key.startsWith(SKILL_STEP.install)) for (const name of skillNamesOf(step)) {
      const row = input.report.items.find(i => i.label === name);
      if (!row) return yield* Effect.fail(new Error('Selected skill is unavailable'));
      installed.add(name); skills[name] = { source: row.group };
    }
  }
  const groups = updateManifestGroups({ desired: input.desired.skills, lock: { skills }, installed: [...installed], prunedNames: pruned, heldManifestGroups: input.heldManifestGroups, heldItemIds: input.heldItemIds });
  const outcome = manifestOutcome({ before, groups, prunedNames: pruned });
  if (!outcome.write) return yield* Effect.fail(new UpdateManifestRefused(outcome.reason));
  const text = emitManifest(groups);
  yield* validateAuthorBinding(input.author);
  if (authorDigest((yield* readSkillLockEvidence).bytes) !== authorDigest(evidence.bytes) || JSON.stringify(yield* installedSkillNames) !== JSON.stringify(names)) return yield* Effect.fail(new Error('Machine update observations changed'));
  return { author: input.author, documents: authorDigest(text) === baseline.sha256 ? [] : [{ path: MANIFEST_FILE, beforeSha256: baseline.sha256, text, afterSha256: authorDigest(text)! }] };
});

// Both transports replace the bound author only when actual machine outcomes equal the accepted proposal.
export const executeUpdateManifest = (input: {
  edit: PreparedAuthorEdit; desired: DesiredConfig; selected: Plan; heldManifestGroups?: readonly SkillGroup[]; heldItemIds?: readonly string[];
}, signal: AbortSignal, observer: MutationObserver, revalidateInputs: Effect.Effect<void, unknown, AuthorServices> = Effect.void):
  Effect.Effect<{ committedPaths: readonly string[]; remainingPaths: readonly string[] }, unknown, AuthorServices | Backups> => Effect.gen(function* () {
  const context = yield* Effect.context<AuthorServices>();
  const revalidate = revalidateInputs.pipe(Effect.provideContext(context));
  yield* revalidate;
  yield* validateAuthorBinding(input.edit.author);
  const evidence = yield* readSkillLockEvidence;
  const installed = yield* installedSkillNames;
  const prunedNames = input.selected.steps.filter(step => step.key === SKILL_STEP.remove).flatMap(skillNamesOf).filter(name => !installed.includes(name));
  const groups = updateManifestGroups({ desired:input.desired.skills,lock:evidence.lock,installed,prunedNames,heldManifestGroups:input.heldManifestGroups,heldItemIds:input.heldItemIds });
  const expected = input.edit.documents.find(document => document.path === MANIFEST_FILE)?.afterSha256
    ?? input.edit.author.files.find(file => file.path === MANIFEST_FILE)?.sha256;
  if (authorDigest(emitManifest(groups)) !== expected) return yield* Effect.fail(new Error('Observed outcomes differ from the reviewed author proposal; preview again'));
  if (authorDigest((yield* readSkillLockEvidence).bytes) !== authorDigest(evidence.bytes) || JSON.stringify(yield* installedSkillNames) !== JSON.stringify(installed))
    return yield* Effect.fail(new Error('Machine update observations changed; preview again'));
  return yield* executeAuthorEdit(input.edit,signal,{ ...observer,pending:key => Effect.andThen(revalidate,observer.pending(key)) });
});
