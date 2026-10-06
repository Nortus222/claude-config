import type { DesiredConfig, ResolvedFile } from '@nortuscc/profile-engine';
import type { Observed, PlanKind, Selection, Skipped, Step, StepAction } from '../model.ts';
import { configFileId, itemKey } from './observe.ts';

// The skip reason a refused uninstall is recognised by.
export const CHANGED_SINCE_APPLY = 'changed since nortuscc wrote it';

type Decision = Step | Skipped | undefined;

const has = (item: Observed, fact: string) => item.facts?.includes(fact) ?? false;
const machineSide = (file: ResolvedFile) => `${file.home}:${file.dest}`;
const repoSide = (file: ResolvedFile) => `repo:${file.src}`;
const skip = (item: Observed, reason: string): Skipped => ({ key: item.key, reason });
const step = (key: string, action: StepAction, summary: string, touches: string): Step =>
  ({ key, domain: 'config', action, summary, touches: [touches], interruptible: false });

const blocked = (item: Observed): Skipped => skip(item,
  item.state === 'missing-repo' ? 'missing from the repo'
    : item.state === 'unparseable-local' ? 'not valid JSON on this machine; fix it by hand'
    : item.state === 'invalid' ? item.note ?? 'the repo file is invalid'
    : `nothing to do for ${item.state}`);

// repo -> machine. A local-only change is capture's; force (--take-repo) discards it for a whole
// file but never for a settings key.
const applyDecision = (item: Observed, file: ResolvedFile, force: boolean): Decision => {
  const action: StepAction = file.mode === 'copy' ? 'write-file' : 'merge-keys';
  const write = () => step(item.key, action, `${file.mode === 'copy' ? 'copy' : 'set'} ${item.label} from the repo`, machineSide(file));
  switch (item.state) {
    case 'repo-ahead':
    case 'unmanaged':
      return write();
    // Recording a clean settings key also prunes the document's dropped-key baselines.
    case 'clean':
      return has(item, 'baseline-stale') ? step(item.key, action, `record ${item.label} as in sync`, machineSide(file))
        : has(item, 'baseline-dropped') ? step(item.key, action, `forget dropped keys of ${file.dest}`, machineSide(file))
        : undefined;
    case 'local-ahead':
      return force && file.mode === 'copy' ? write() : skip(item, 'changed on this machine; capture keeps it');
    case 'conflict':
      return force ? write() : skip(item, 'changed on both sides; --take-repo keeps the repo version');
    default:
      return blocked(item);
  }
};

// machine -> repo, for files the repo lets a machine publish.
const captureDecision = (item: Observed, file: ResolvedFile, force: boolean): Decision => {
  if (!file.capture) return skip(item, 'repo-owned: local changes are never captured');
  const capture = () => step(item.key, 'capture-file', `capture ${item.label} into the repo`, repoSide(file));
  switch (item.state) {
    case 'local-ahead':
      return capture();
    case 'unmanaged':
      return has(item, 'local-absent') ? undefined : capture();
    case 'clean':
      return has(item, 'baseline-stale') ? step(item.key, 'capture-file', `record ${item.label} as in sync`, repoSide(file)) : undefined;
    case 'repo-ahead':
      return skip(item, 'the repo is ahead; apply takes it');
    case 'conflict':
      return force ? capture() : skip(item, 'changed on both sides; --take-local keeps the local version');
    default:
      return blocked(item);
  }
};

// Machine-wide: every document nortuscc recorded, managed here or not. One changed item refuses
// its whole document unless forced.
const uninstallSteps = (items: ReadonlyArray<Observed>, force: boolean, files: ReadonlyArray<ResolvedFile>) => {
  const steps: Step[] = [];
  const skipped: Skipped[] = [];
  for (const id of new Set(items.map((i) => configFileId(i.key)))) {
    const file = files.find((f) => f.id === id);
    const mine = items.filter((i) => configFileId(i.key) === id);
    if (!file || !mine.some((i) => has(i, 'recorded'))) continue;
    const key = itemKey(id);
    if (!force && mine.some((i) => has(i, 'local-changed'))) skipped.push({ key, reason: CHANGED_SINCE_APPLY });
    else steps.push(step(key, 'restore', `restore ${file.dest} to its state before nortuscc`, machineSide(file)));
  }
  return { steps, skipped };
};

// Files are looked up in the report's desired configuration, which machine overrides may have changed.
export const configSteps = (items: ReadonlyArray<Observed>, selection: Selection, kind: PlanKind, desired: DesiredConfig) => {
  if (kind === 'uninstall') return uninstallSteps(items, selection.force, desired.files);
  // `update` adopts, refreshes and prunes skills; config has nothing to do, and must not fall through to capture.
  if (kind === 'update') return { steps: [], skipped: [] };
  const steps: Step[] = [];
  const skipped: Skipped[] = [];
  for (const item of items) {
    const file = desired.files.find((f) => f.id === configFileId(item.key));
    const decision: Decision = !file ? skip(item, 'not a managed file')
      : item.target !== undefined && !selection.targets.includes(item.target) ? skip(item, 'target not selected')
      : item.disposition === 'excluded' ? skip(item, 'not managed on this machine')
      : kind === 'apply' ? applyDecision(item, file, selection.force)
      : captureDecision(item, file, selection.force);
    if (decision === undefined) continue;
    if ('action' in decision) steps.push(decision);
    else skipped.push(decision);
  }
  return { steps, skipped };
};
