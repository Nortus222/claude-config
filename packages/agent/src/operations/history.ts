import { basename } from 'node:path';
import { Schema } from 'effect';
import { backupFolderTime } from '@nortuscc/machine';
import { OperationHistoryEventSchema } from './schemas.ts';
import { safeOwnerString } from './safety.ts';

const safe = (value: unknown): boolean => typeof value === 'string'
  ? (value === '' || safeOwnerString(value)) && !value.includes('nmt_')
  : Array.isArray(value) ? value.every(safe)
  : value !== null && typeof value === 'object' ? Object.values(value).every(safe) : true;
const outcomeNote = (outcome: unknown): string => {
  switch (outcome) {
    case 'ok': return 'Step completed';
    case 'failed': return 'Step failed';
    case 'cancelled': return 'Step cancelled';
    default: throw new Error('Unsupported historical outcome');
  }
};
const backupId = (path: unknown): string => {
  if (typeof path !== 'string' || backupFolderTime(basename(path)) === undefined) throw new Error('Unsupported backup');
  return basename(path);
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported historical record');
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('Unsupported historical list');
  return value;
};

// Explicit fields only. Unsupported historical payloads never become public diagnostics.
export function projectHistoryEvent(raw: unknown): typeof OperationHistoryEventSchema.Type | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const e = raw as Record<string, unknown>;
  const base = { at: e.at, actor: e.actor };
  const unknown = { ...base, kind: 'unknown', message: 'Unsupported historical event' };
  try { Schema.decodeUnknownSync(OperationHistoryEventSchema, { onExcessProperty: 'error' })(unknown); }
  catch { return undefined; }
  try {
    const event: Record<string, unknown> = { ...base, kind: e.kind };
    if (e.operation === 'applyChange') {
      event.operation = e.operation;
      event.scope = { kind: 'machine' };
      event.requestId = e.requestId;
    }
    if (e.remoteMachine !== undefined) event.remoteMachine = e.remoteMachine;
    if (e.runId !== undefined) event.runId = e.runId;
    switch (e.kind) {
      case 'decided':
        event.detail = { kind: 'decision', setupId: e.setupId, itemId: e.itemId,
          revision: e.revision, commit: e.commit, choice: e.decision };
        break;
      case 'setup-trusted':
        event.detail = { kind: 'setup', setupId: e.setupId };
        break;
      case 'revision-verified': case 'revision-rejected':
        event.detail = { kind: 'revision', setupId: e.setupId, revision: e.revision, accepted: e.kind === 'revision-verified' };
        break;
      case 'policy-changed':
        event.detail = { kind: 'policy', from: e.from, to: e.to, origin: e.origin };
        break;
      case 'paused': case 'resumed':
        event.detail = { kind: 'pause', reason: e.kind === 'paused' ? 'Automatic application paused' : 'Application pause cleared' };
        break;
      case 'backups-pruned':
        event.detail = { kind: 'backups', ids: array(e.folders).map(backupId), pruned: true,
          ...(e.limited === true ? { limited: true } : {}) };
        break;
      case 'apply-finished':
        event.steps = array(e.steps).map(value => {
          const step = record(value);
          return { key: step.key, outcome: step.outcome, note: outcomeNote(step.outcome) };
        });
        if (e.backup !== null) event.detail = { kind: 'backups',
          ids: [backupId(e.backup === 'pruned' ? e.prunedFolder : e.backup)], pruned: e.backup === 'pruned' };
        break;
      case 'apply-started': case 'operation-checkpoint':
        event.keys = e.keys;
        break;
      case 'skill-addition':
        event.message = 'Skill addition recorded';
        break;
      case 'held': case 'ready': case 'outbox-dropped': break;
      default: throw new Error('Unsupported event');
    }
    if (!safe(event)) throw new Error('Unsafe historical field');
    return Schema.decodeUnknownSync(OperationHistoryEventSchema, { onExcessProperty: 'error' })(event);
  } catch { return Schema.decodeUnknownSync(OperationHistoryEventSchema)(unknown); }
}
