import { Effect } from 'effect';
import { canonical, type Decision } from '@nortuscc/machine';
import { entryOf, itemIdOf, type Snapshot } from '@nortuscc/sync';
import { type SetupStatus, type SyncRevision } from '@nortuscc/hosted-protocol';
import type { AgentStatus, JobInspection } from './job.ts';

export const latestChanges = (records: ReadonlyArray<SyncRevision>) => {
  const changes = new Map<string, { revision: number; removed: boolean }>();
  for (const r of records) for (const item of r.items) changes.set(item.id, { revision: r.number, removed: item.change === 'removed' });
  return changes;
};

export const currentChoices = (records: ReadonlyArray<SyncRevision>, decisions: ReadonlyArray<Decision>) => {
  const changes = latestChanges(records);
  return new Map(decisions.filter((d) => d.setupId === records[0]?.setupId && d.revision !== null
    && d.revision >= (changes.get(d.itemId)?.revision ?? Infinity) && d.revision <= records.at(-1)!.number).map((d) => [d.itemId, d.decision]));
};

// Complete history membership, including removals. The caller supplies only freshly proven observations.
export const projectHostedSetup = (input: {
  readonly records: ReadonlyArray<SyncRevision>; readonly decisions: ReadonlyArray<Decision>;
  readonly observed: ReadonlyArray<string>; readonly status: AgentStatus; readonly revisionApplied: number;
}): SetupStatus => {
  const { records, status } = input;
  const choices = currentChoices(records, input.decisions);
  const observed = new Set(input.observed);
  const adopted: string[] = [], skipped: string[] = [], pending: string[] = [], waitingForPerson: string[] = [];
  for (const [id, change] of latestChanges(records)) {
    const choice = choices.get(id);
    if (choice === 'skip') skipped.push(id);
    else if (choice === 'accept' && !change.removed && observed.has(id)) adopted.push(id);
    else if (choice === 'accept' && !change.removed && status.policy === 'auto-apply' && status.paused === null
      && status.pending.some((p) => p.itemId === id)
      && status.pending.filter((p) => p.itemId === id).every((p) => p.verdict.kind === 'inert')) pending.push(id);
    else waitingForPerson.push(id);
  }
  return { setupId: records[0]!.setupId, revisionApplied: input.revisionApplied, adopted, skipped, pending, waitingForPerson };
};

// Only config clean rows currently prove local ownership. Native integration/skill presence
// and hook registration do not prove ownership or executable bytes.
export const observedHostedItems = (inspection: JobInspection, head: Snapshot, candidates: ReadonlyArray<string>, successful: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    if (inspection.report.probeErrors.length || inspection.desired.issues.length) return [];
    const observed: string[] = [];
    for (const id of candidates) {
      const effective = { desired: inspection.desired, repo: inspection.paths.repo };
      const actualEntry = yield* entryOf(id, effective);
      const wantedEntry = yield* entryOf(id, head);
      if (!actualEntry || !wantedEntry || canonical(actualEntry) !== canonical(wantedEntry)) continue;
      if (id.startsWith('integration:') && inspection.desired.integrations.find((i) => `integration:${i.id}` === id)?.declaration.type === 'hook') continue;
      const skill = id.startsWith('skill:') ? inspection.desired.skills.find((s) => `skill:${s.source}/${s.name}` === id) : undefined;
      const rows = inspection.report.items.filter((r) => itemIdOf(r.key, inspection.desired) === id
        || (skill !== undefined && r.key.startsWith('skill-link:') && r.key.endsWith(`:${skill.name}`)));
      if (rows.length && rows.every((r) => r.disposition === 'in-sync'
        && (r.domain === 'config' && r.state === 'clean' || successful.includes(id)))) observed.push(id);
    }
    return observed;
  });
