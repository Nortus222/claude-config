import { decodeRunView, type RunView } from '@nortuscc/agent/operations';

export const skillRun = (fields: Partial<RunView> = {}): RunView => decodeRunView(Object.fromEntries(Object.entries({
  runId: 'addition-run', state: 'succeeded', operation: 'applyChange', scope: { kind: 'machine' },
  intent: { requestId: 'addition-request', inputDigest: 'a'.repeat(64), planId: 'addition-plan',
    change: { kind: 'addSkill', candidateId: 'candidate', targets: ['claude'] },
    skillAddition: { source: 'owner/repo', acceptedRevision: 'b'.repeat(40), sourceDir: 'skills/design', selectorName: 'Design Review', installedName: 'design-review',
      blob: 'c'.repeat(40), tree: 'd'.repeat(40), internal: false, targets: ['claude'], declaration: { source: 'owner/repo', name: 'design-review', targets: ['claude'] }, policy: 'upstream' } },
  intentSaved: true, intentState: 'saved', steps: [], result: { status: 'done', ok: 3, failed: 0 },
  installation: { state: 'verified', message: 'Accepted content and selected native catalogs verified', sharedStore: { codexScans: true, visibility: 'shared' },
    claude: { verified: true, physical: { status: 'present', path: '/isolated/SKILL.md' }, catalog: { status: 'present' }, restrictions: { status: 'no-known-denial', diagnostics: [] },
      limits: { selectedSource: 'not-attested', invocationAuthorization: 'not-attested', configRoot: 'requested-environment-only', managedStartup: 'remains-active' } },
    nextActions: [
      { kind: 'share_with_my_machines', capability: { available: false, reason: 'Sharing requires the personal sharing workflow and a user destination.' }, requiredDestination: 'user' },
      { kind: 'promote_to_profile', capability: { available: false, reason: 'Promotion requires the profile publication workflow and an owned profile destination.' }, requiredDestination: 'profile' },
    ] }, ...fields,
}).filter(([, value]) => value !== undefined)));
