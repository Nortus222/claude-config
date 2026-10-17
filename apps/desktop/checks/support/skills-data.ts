import { decodeChangePreview, decodeRunView, type ChangePreview, type OperationOutput, type RunView } from '@nortuscc/agent/operations';
export type Skill = Extract<OperationOutput<'inspectIntent'>['items'][number], { kind: 'skill' }>;
export const row = (name = 'tdd', fields: Partial<Skill> = {}): Skill => ({ kind: 'skill', source: 'owner/skills', name, choice: null, defaultEnabled: true, enabled: true,
  from: { layer: 'base', source: 'skills-manifest.txt' }, declaredFrom: { layer: 'base', source: 'skills-manifest.txt' }, targets: ['claude', 'codex'], policy: 'upstream', ...fields });
export const inventory = (items: Skill[] = [row()], fields = {}): Omit<OperationOutput<'inspectIntent'>, 'items'> & { items: readonly Skill[] } => ({ generation: '1:1', items, nextCursor: null, ...fields });
export const updates = (fields = {}): OperationOutput<'inspectUpdates'> => ({ generation: '1', nextCursor: null, unavailable: false, items: [
  { id: 'skill:owner/skills/tdd', key: 'skills:update:tdd', source: 'owner/skills', name: 'tdd', state: 'outdated', targets: ['claude', 'codex'], policy: 'upstream', offered: null, repairRoute: 'reconcile' },
], ...fields });
export const choiceChange = { kind: 'machineIntent' as const, patch: { kind: 'skill' as const, source: 'owner/skills', name: 'tdd', action: 'disable' as const } };
type SkillChange = Extract<ChangePreview['change'], { kind: 'update' | 'machineIntent' }>;
export const preview = (change: SkillChange = choiceChange, planId = 'plan-1'): ChangePreview => decodeChangePreview({ planId, scope: { kind: 'machine' }, generation: '1', change,
  plan: { kind: change.kind === 'update' ? 'update' : 'apply', steps: [{ key: 'skills:tdd', domain: 'skills', action: change.kind === 'update' ? 'update-skills' : 'write-file', summary: 'Save the selected skill choice', touches: [], interruptible: false }], skipped: [] }, nextActions: [],
  ...(change.kind === 'machineIntent' ? { machineIntent: { intentChanges: [{ kind: 'machine-choice', action: 'action' in change.patch ? change.patch.action : 'removeSkillDeclaration', message: 'Save choice', before: row(), after: row('tdd', { choice: false }) }], installationEffects: ['Apply on Changes makes installation changes.'], sourceImpact: [] } } : { actionEffects: ['Update selected skills'] }),
});
export const receipt = (state: RunView['state'] = 'running', change: SkillChange = choiceChange): RunView => decodeRunView({ runId: 'run-1', state, operation: 'applyChange', scope: { kind: 'machine' }, intentSaved: state === 'succeeded', steps: [], result: state === 'succeeded' ? { status: 'done', ok: 1, failed: 0 } : null,
  intent: { requestId: 'request-1', inputDigest: 'a'.repeat(64), planId: 'plan-1', change, parity: { kind: change.kind, generation: '1', baselineDigest: 'b'.repeat(64), planDigest: 'c'.repeat(64), plannedKeys: ['skills:tdd'] } },
});
export const status = (fields = {}) => ({ at: 'now', policy: 'notify' as const, paused: null, trusted: true, pending: [], drift: [], conflicts: [], probeErrors: [], counts: { pending: 0, held: 0, ready: 0, drift: 0 }, ...fields });
export const inspection = () => ({ profile: { repo: '/r', revision: 'abc', overrides: '/s/overrides.json', issues: [] }, items: [], probeErrors: [], status: status() });
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(settle => { resolve = settle; }); return { promise, resolve }; }
