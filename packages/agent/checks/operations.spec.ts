import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonSchema, Schema, SchemaRepresentation } from 'effect';
import {
  operationDefinitions, operationJsonSchemas, decodeOperationInput, decodeOperationOutput,
  ReconcilePreviewSchema, decodeOperationScope, decodeContextResult, decodeRunView, projectContext, capabilityInventory,
} from '../src/operations/index.ts';
import { InspectResultSchema, PreviewResultSchema, decodeInspectResult, decodePreviewResult, decodeMessage, decodeRequest, type Message } from '../src/ipc/protocol.ts';

const change = { kind: 'reconcile', only: ['skill:x'] } as const;
const preview = { planId: 'p', scope: { kind: 'machine' }, change, generation: 'g', plan: { kind: 'apply', steps: [], skipped: [] }, nextActions: [] };
const context = {
  app: { ownership: 'app', version: '0.1.0', runtimeId: 'runtime-1' },
  agent: { version: '0.1.0', protocol: 3 }, targets: ['claude', 'codex'],
  setups: { state: 'available', items: [{ setupId: 'local', trusted: true, revision: 'a'.repeat(40) }] },
  profiles: { state: 'unavailable', reason: 'Profile ownership is not available.' },
  account: { state: 'signed-out' }, policy: 'notify', paused: null,
  scopes: { machine: { available: true }, user: { available: false, reason: 'No sharing destination.' }, profile: { available: false, reason: 'No owned profile.' } },
  capabilities: capabilityInventory, diagnostics: [],
};
const run = {
  runId: 'r', state: 'accepted', operation: 'applyChange', scope: { kind: 'machine' },
  intent: { requestId: 'q', inputDigest: 'd'.repeat(64), planId: 'p', change },
  intentSaved: false, steps: [], result: null,
};

test('machine scope is normalized for every operation and explicit scopes survive decoding', () => {
  const inputs = { listBackups:{limit:1},getContext: {}, inspect: {}, previewChange: { change }, applyChange: { planId: 'p', requestId: 'q' }, getRun: { runId: 'r' }, listRuns: { limit: 10 }, cancelRun: { runId: 'r' }, history: { limit: 10 } };
  for (const [name, input] of Object.entries(inputs)) {
    assert.deepEqual(decodeOperationInput(name as keyof typeof operationDefinitions, input), { ...input, scope: { kind: 'machine' } });
  }
  for (const scope of [{ kind: 'machine' }, { kind: 'user' }, { kind: 'profile', profileId: 'owned-profile' }]) assert.deepEqual(decodeOperationScope(scope), scope);
});

test('profile scope requires a bounded profile ID and rejects unknown fields', () => {
  for (const scope of [{ kind: 'profile' }, { kind: 'profile', profileId: '' }, { kind: 'profile', profileId: 'x'.repeat(101) }, { kind: 'machine', profileId: 'x' }, { kind: 'user', token: 'private' }]) assert.throws(() => decodeOperationScope(scope));
});

test('operation inputs reject unknown fields, oversized IDs and unsupported changes', () => {
  for (const input of [{ change, extra: true }, { change: { ...change, url: 'https://example.com' } }, { change: { kind: 'addSkill', only: [] } }, { change: { kind: 'reconcile', only: ['x'.repeat(501)] } }, { scope: null, change }]) assert.throws(() => decodeOperationInput('previewChange', input));
  for (const input of [{ planId: 'x'.repeat(101), requestId: 'q' }, { planId: 'p', requestId: '' }, { planId: 'p', requestId: 'q', automatic: true }]) assert.throws(() => decodeOperationInput('applyChange', input));
  assert.throws(() => decodeOperationInput('listRuns', { limit: 501 }));
  assert.throws(() => decodeOperationInput('history', { limit: 1, before: { at: 'invalid', seq: 0 } }));
});

test('future capabilities are unavailable inventory entries without executable definitions', () => {
  for (const name of ['shareWithMyMachines', 'promoteToProfile']) {
    const state = capabilityInventory[name as keyof typeof capabilityInventory];
    assert.equal(state.available, false);
    assert.ok('reason' in state && state.reason.length > 0);
    assert.equal(name in operationDefinitions, false);
  }
  assert.deepEqual(Object.keys(operationDefinitions), ['listBackups','agentStatus','accountState','watchSources','inspectSourceDiff','pinImpact','draftChangelog','setupReview','inspectSetups', 'incomingChanges', 'prepareTrustRequest', 'resolveSkillCandidate', 'getContext', 'inspectUpdates', 'inspectIntent', 'inspect', 'previewChange', 'applyChange', 'getRun', 'listRuns', 'cancelRun', 'abandonRun', 'history']);
  for (const [name, definition] of Object.entries(operationDefinitions)) {
    assert.equal(definition.name, name);
    assert.deepEqual(definition.scopes, ['machine']);
    assert.equal(definition.mutation, name === 'applyChange' || name === 'cancelRun' || name === 'abandonRun');
  }
});

test('context projection publishes only selected validated fields and reports unavailable information', () => {
  assert.deepEqual(decodeContextResult(context), context);
  const projected = projectContext({ ...context, token: 'private', appPath: '/private', app: { ...context.app, credential: 'secret' } });
  assert.deepEqual(projected, context);
  assert.throws(() => decodeContextResult({ ...context, token: 'private' }));
  assert.throws(() => decodeContextResult({ ...context, account: { state: 'signed-out', token: 'private' } }));
  assert.throws(() => projectContext({ ...context, agent: { version: 'x', protocol: -1 } }));
});

test('preview, run and follow-up outputs decode strictly', () => {
  assert.deepEqual(decodeOperationOutput('previewChange', preview), preview);
  assert.deepEqual(decodeRunView(run), run);
  for (const bad of [{ ...preview, extra: 1 }, { ...preview, scope: { kind: 'profile' } }, { ...preview, nextActions: [{ kind: 'promote_to_profile', capability: { available: false, reason: 'Unavailable' }, requiredDestination: 'profile', authorization: true }] }]) assert.throws(() => decodeOperationOutput('previewChange', bad));
  for (const bad of [{ ...run, runId: 'x'.repeat(101) }, { ...run, intent: { ...run.intent, command: 'install' } }, { ...run, result: { status: 'done', ok: -1, failed: 0 } }, { ...run, steps: [{ key: 'x', outcome: 'ok', note: '', token: 'secret' }] }]) assert.throws(() => decodeRunView(bad));
});

test('intent and machine inspection wire results preserve profile origins and issues', () => {
  const from = { layer: 'profile', source: 'profiles/personal.json' };
  const intent = { generation: 'g', nextCursor: null, items: [
    { kind: 'skill', source: 'owner/skills', name: 'review', enabled: true, from, declaredFrom: from, targets: ['codex'], policy: 'upstream' },
    { kind: 'issue', ...from, message: 'Configuration input is invalid; inspect the owning document in the app' },
  ] };
  assert.deepEqual(decodeOperationOutput('inspectIntent', intent), intent);
  const inspection = {
    profile: { repo: '/r', revision: null, overrides: '/o', issues: [{ ...from, path: 'extends', message: 'Missing parent' }] },
    items: [{ key: 'skill:owner/skills/review', domain: 'skills', label: 'review', group: 'owner/skills', state: 'missing', disposition: 'apply', from }], probeErrors: [],
  };
  assert.deepEqual(decodeInspectResult(inspection), inspection);
});

test('legacy IPC machine result schemas remain compatible with shared operation plans', () => {
  assert.equal(operationDefinitions.inspect.output, InspectResultSchema);
  assert.deepEqual(Schema.decodeUnknownSync(ReconcilePreviewSchema.fields.plan)(preview.plan), preview.plan);
  assert.deepEqual(Schema.decodeUnknownSync(PreviewResultSchema, { onExcessProperty: 'error' })({ planId: 'p', plan: preview.plan }), { planId: 'p', plan: preview.plan });
});

test('JSON schemas preserve strict object fields, scope unions and input bounds', () => {
  const input = operationJsonSchemas.previewChange.input as any;
  assert.equal(input.type, 'object');
  assert.equal(input.additionalProperties, false);
  assert.ok(!input.required.includes('scope'));
  const scopes = input.properties.scope.anyOf ?? input.properties.scope.oneOf;
  assert.equal(scopes.length, 3);
  const profile = scopes.find((scope: any) => scope.properties.kind.enum?.includes('profile'));
  assert.ok(profile.required.includes('profileId'));
  assert.equal(profile.properties.profileId.minLength, 1);
  assert.equal(profile.properties.profileId.maxLength, 100);
  assert.equal(profile.additionalProperties, false);
  const reconcile = (input.properties.change.anyOf ?? input.properties.change.oneOf).find((change: any) => change.properties.kind.enum.includes('reconcile'));
  assert.equal(reconcile.additionalProperties, false);
  assert.equal(reconcile.properties.only.maxItems, 10_000);
  assert.equal(reconcile.properties.only.items.maxLength, 500);
  const inspectOutput = operationJsonSchemas.inspect.output as any;
  assert.equal(inspectOutput.properties.items.items.properties.note.type, 'string');
  assert.throws(() => decodeOperationOutput('inspect', { profile: { repo: '/r', revision: null, overrides: '/o', issues: [] }, items: [{ key: 'k', domain: 'skills', label: 'x', group: 'x', state: 'missing', disposition: 'apply', note: null }], probeErrors: [] }));
  const history = operationJsonSchemas.history.input as any;
  assert.ok(history.properties.before.properties.at.pattern);
  assert.equal(history.properties.before.properties.seq.maximum, Number.MAX_SAFE_INTEGER);
  const run = operationJsonSchemas.getRun.output as any;
  assert.equal((run.anyOf ?? run.oneOf)[0].properties.intent.properties.inputDigest.pattern, '^[0-9a-f]{64}$');
  for (const schemas of Object.values(operationJsonSchemas)) {
    const inspect = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object') assert.equal(node.additionalProperties, false);
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(inspect); else inspect(value);
    };
    inspect(schemas.input);
    inspect(schemas.output);
  }
});


test('shared optional wire fields still accept absence and values while rejecting null', () => {
  const item = { key: 'k', domain: 'skills', label: 'x', group: 'x', state: 'missing', disposition: 'apply' };
  const inspected = { profile: { repo: '/r', revision: null, overrides: '/o', issues: [] }, items: [item], probeErrors: [] };
  assert.deepEqual(decodeInspectResult(inspected), inspected);
  for (const [field, value] of Object.entries({ target: 'claude', note: 'missing', from: { layer: 'base', source: 'repo' } })) {
    const result = { ...inspected, items: [{ ...item, [field]: value }] };
    assert.deepEqual(decodeInspectResult(result), result);
    assert.throws(() => decodeInspectResult({ ...inspected, items: [{ ...item, [field]: null }] }));
  }
  const step = { key: 'k', domain: 'skills', action: 'install-skills', summary: 'install x', touches: [], interruptible: true };
  for (const value of [undefined, ['claude']]) {
    const result = { planId: 'p', plan: { kind: 'apply', steps: [{ ...step, ...(value === undefined ? {} : { targets: value }) }], skipped: [] } };
    assert.deepEqual(decodePreviewResult(result), result);
  }
  assert.throws(() => decodePreviewResult({ planId: 'p', plan: { kind: 'apply', steps: [{ ...step, targets: null }], skipped: [] } }));
  for (const progress of [{ type: 'done', ok: 1, failed: 0 }, { type: 'cancelled', remaining: [] }]) {
    for (const value of [undefined, '/backups']) {
      const event = { version: 3, event: 'progress', runId: 'r', progress: { ...progress, ...(value === undefined ? {} : { backups: value }) } };
      assert.deepEqual(decodeMessage(event), event);
    }
    assert.throws(() => decodeMessage({ version: 3, event: 'progress', runId: 'r', progress: { ...progress, backups: null } }));
  }
});

test('operation contracts have a public package entry point independent of execution exports', async () => {
  const operations = await import('@nortuscc/agent/operations');
  assert.equal(operations.operationDefinitions, operationDefinitions);
  assert.equal('AgentSession' in operations, false);
  assert.equal('runAgent' in operations, false);
});

const acceptsOperation = (name: keyof typeof operationDefinitions, input: unknown): boolean => {
  try { decodeOperationInput(name, input); return true; } catch (error) {
    if (Schema.isSchemaError(error)) return false;
    throw error;
  }
};
const acceptsJsonInput = (name: keyof typeof operationDefinitions, input: unknown): boolean => {
  const schema = SchemaRepresentation.fromJsonSchemaDocument(
    JsonSchema.fromSchemaDraft2020_12(operationJsonSchemas[name].input), { patterns: 'apply' },
  );
  return Schema.decodeUnknownResult(Schema.toType(schema), { onExcessProperty: 'error' })(input)._tag === 'Success';
};

test('exported JSON Schema and operation decoding agree on Unicode ID and key bounds', () => {
  const cases = [
    { name: 'inspect', input: { scope: { kind: 'profile', profileId: '😀'.repeat(51) } }, valid: true },
    { name: 'inspect', input: { scope: { kind: 'profile', profileId: '😀'.repeat(100) } }, valid: true },
    { name: 'inspect', input: { scope: { kind: 'profile', profileId: '😀'.repeat(101) } }, valid: false },
    { name: 'applyChange', input: { planId: '😀'.repeat(51), requestId: 'q' }, valid: true },
    { name: 'getRun', input: { runId: '😀'.repeat(101) }, valid: false },
    { name: 'previewChange', input: { change: { kind: 'reconcile', only: ['😀'.repeat(500)] } }, valid: true },
    { name: 'previewChange', input: { change: { kind: 'reconcile', only: ['😀'.repeat(501)] } }, valid: false },
    { name: 'inspect', input: { scope: { kind: 'profile', profileId: '' } }, valid: false },
    { name: 'inspect', input: { scope: { kind: 'profile', profileId: '😀', extra: true } }, valid: false },
  ] as const;
  for (const { name, input, valid } of cases) {
    assert.equal(acceptsJsonInput(name, input), valid, `${name} JSON Schema`);
    assert.equal(acceptsOperation(name, input), valid, `${name} operation decoder`);
  }
});

test('exported history JSON Schema and operation decoding agree on calendar and clock boundaries', () => {
  const cases = [
    ['2026-10-14T25:00:00Z', false],
    ['2026-10-14T23:59:59Z', true],
    ['2026-10-14T00:00:00.123456+23:59', true],
    ['2026-10-14T00:00:00-23:59', true],
    ['2026-10-14T00:00:00+24:00', false],
    ['2026-10-14T00:00:00+00:60', false],
    ['2026-10-14T24:00:00Z', false],
    ['2026-10-14T23:60:00Z', false],
    ['2026-10-14T23:59:60Z', false],
    ['2026-02-29T00:00:00Z', false],
    ['2024-02-29T00:00:00Z', true],
    ['2000-02-29T00:00:00Z', true],
    ['1900-02-29T00:00:00Z', false],
    ['0000-02-29T00:00:00Z', true],
    ['2026-04-31T00:00:00Z', false],
    ['2026-04-30T00:00:00Z', true],
    ['2026-12-31T00:00:00Z', true],
    ['2026-13-01T00:00:00Z', false],
    ['2026-10-00T00:00:00Z', false],
    ['2026-10-14T00:00:00Z\n', false],
    ['yesterday', false],
  ] as const;
  for (const [at, valid] of cases) {
    const input = { limit: 1, before: { at, seq: 0 } };
    assert.equal(acceptsJsonInput('history', input), valid, `${at} JSON Schema`);
    assert.equal(acceptsOperation('history', input), valid, `${at} operation decoder`);
  }
});

test('representable operation constraints preserve the separate legacy IPC validators', () => {
  const head = { version: 3, id: 'r' };
  for (const at of ['2026-10-14T24:00:00Z', '2026-04-31T00:00:00Z']) {
    assert.deepEqual(decodeRequest({ ...head, command: 'history', limit: 1, before: { at, seq: 0 } }).version, 3);
    assert.equal(acceptsOperation('history', { limit: 1, before: { at, seq: 0 } }), false);
  }
  assert.throws(() => decodeRequest({ ...head, command: 'apply', planId: '😀'.repeat(51) }));
  assert.equal(acceptsOperation('applyChange', { planId: '😀'.repeat(51), requestId: 'q' }), true);
  assert.throws(() => decodeRequest({ ...head, command: 'history', limit: 1, before: { at: '2026-10-14T25:00:00Z', seq: 0 } }));
});

test('skill operation wire contracts require explicit targets and paired addition preview evidence', () => {
  for (const change of [{ kind: 'addSkill', candidateId: 'id' }, { kind: 'addSkill', candidateId: '/caller/path', targets: [] }, { kind: 'addSkill', candidateId: 'id', targets: ['unknown'] }, { kind: 'addSkill', candidateId: 'id', targets: ['claude'], sourceDir: '/caller/path' }]) assert.throws(() => decodeOperationInput('previewChange', { change }));
  assert.throws(() => decodeOperationOutput('previewChange', { ...preview, change: { kind: 'addSkill', candidateId: 'id', targets: ['claude'] } }));
  assert.throws(() => decodeOperationInput('resolveSkillCandidate', { name: '', source: 'owner/repo' }));
  assert.throws(() => decodeOperationInput('resolveSkillCandidate', { name: 'skill', directory: '/caller/path' }));
});

test('semantic operation plans remain separate from legacy physical plans', () => {
  for (const [domain, action] of [['intent', 'save-intent'], ['sync', 'save-decision'], ['sources', 'edit-source'], ['agent', 'set-policy'], ['agent', 'resume'], ['account', 'sign-in'], ['account', 'sign-out'], ['account', 'sync-account'], ['account', 'patch-machine'], ['backups', 'prune-backups']]) {
    const step = { key: 'k', domain, action, summary: 'Change one item', touches: ['item'], interruptible: false };
    const value = { ...preview, plan: { kind: 'operation', steps: [step], skipped: [] } };
    assert.deepEqual(decodeOperationOutput('previewChange', value), value);
    assert.throws(() => decodePreviewResult({ planId: 'p', plan: value.plan }));
    assert.throws(() => decodeOperationOutput('previewChange', { ...value, plan: { ...value.plan, steps: [{ ...step, action: 'run-command' }] } }));
  }
});

test('parity evidence and acceptance are paired in both engine and JSON schemas', () => {
  const acceptance = { kind: 'reconcile', generation: '1', baselineDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64), plannedKeys: ['k'] };
  const evidence = { kind: 'reconcile', state: 'pending', committedKeys: [], remainingKeys: ['k'], backupIds: [] };
  const valid = { ...run, intent: { ...run.intent, parity: acceptance }, parity: evidence };
  const schema = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(operationJsonSchemas.getRun.output), { patterns: 'apply' });
  for (const [value, expected] of [[valid, true], [{ ...valid, intent: run.intent }, false], [{ ...valid, intent: { ...valid.intent, parity: { ...acceptance, kind: 'account' } } }, false], [{ ...valid, parity: { ...evidence, token: 'secret' } }, false], [{ ...valid, intent: { ...valid.intent, parity: { ...acceptance, planDigest: 'A'.repeat(64) } } }, false]] as const) {
    assert.equal(Schema.decodeUnknownResult(Schema.toType(schema), { onExcessProperty: 'error' })(value)._tag === 'Success', expected);
    assert.equal((() => { try { decodeRunView(value); return true; } catch { return false; } })(), expected);
  }
});

test('intent schemas publish strict patches, bounded reads and kind-paired durable evidence', () => {
  const inputs = [
    { section: 'settings', limit: 100 }, { section: 'settings', limit: 101 }, { section: 'settings', limit: 0 },
    { section: 'settings', extra: true }, { section: 'unknown' },
  ];
  for (const [index, input] of inputs.entries()) {
    assert.equal(acceptsOperation('inspectIntent', input), index === 0);
    assert.equal(acceptsJsonInput('inspectIntent', input), index === 0);
  }
  const intentSchema = (operationJsonSchemas.previewChange.input as any).properties.change.anyOf.find((item: any) => item.properties.kind.enum.includes('machineIntent'));
  assert.match(intentSchema.properties.patch.anyOf[0].properties.value.description, /32768 bytes.*depth <=16.*nodes <=4096/);
  const intentChange = { kind: 'machineIntent', patch: { kind: 'manageConfig', action: 'reset' } };
  assert.equal(acceptsOperation('previewChange', { change: intentChange }), true); assert.equal(acceptsJsonInput('previewChange', { change: intentChange }), true);
  for (const patch of [{ ...intentChange.patch, value: false }, { kind: 'setting', fileId: 'f', key: 'k', action: 'reset', value: 'forbidden' }, { kind: 'skill', name: 'a', action: 'disable' }, { kind: 'integration', id: 'i', action: 'delete' }]) {
    assert.equal(acceptsOperation('previewChange', { change: { kind: 'machineIntent', patch } }), false); assert.equal(acceptsJsonInput('previewChange', { change: { kind: 'machineIntent', patch } }), false);
  }
  for (const value of [NaN, Infinity, 'x'.repeat(32768), Array(4097).fill(null)]) assert.equal(acceptsOperation('previewChange', { change: { kind: 'machineIntent', patch: { kind: 'setting', fileId: 'f', key: 'k', action: 'set', value } } }), false);
  const acceptance = { kind: 'machineIntent', generation: '1', baselineDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64), plannedKeys: ['intent:overrides'] };
  const valid = { ...run, intent: { ...run.intent, change: intentChange, parity: acceptance }, parity: { kind: 'machineIntent', state: 'pending', committedKeys: [], remainingKeys: ['intent:overrides'], backupIds: [], intentState: 'pending', routingEffects: [] } };
  assert.deepEqual(decodeRunView(valid), valid);
  for (const value of [{ ...valid, intent: { ...valid.intent, change } }, { ...valid, parity: { ...valid.parity, kind: 'reconcile' } }, { ...valid, parity: { ...valid.parity, routingEffects: [{ fileId: '/arbitrary', state: 'needsInspection' }] } }]) assert.throws(() => decodeRunView(value));
});

test('source diff schemas retain committed pairs and strictly separate local observations', () => {
  const local = { sourceId: 'owner/repo', skillId: 'skill:owner/repo/one', localObservation: 'a'.repeat(64) };
  const pair = { sourceId: local.sourceId, skillId: local.skillId, fromRevision: 'b'.repeat(40), toRevision: 'c'.repeat(40) };
  for (const [value, valid] of [[local, true], [pair, true], [{ ...local, ...pair }, false], [{ ...local, path: '/private' }, false], [{ ...local, localObservation: 'HEAD' }, false]] as const) {
    assert.equal(acceptsOperation('inspectSourceDiff', value), valid);
    assert.equal(acceptsJsonInput('inspectSourceDiff', value), valid);
    const result = { ...value, generation: '1', state: 'complete', text: '', nextCursor: null };
    const schema = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(operationJsonSchemas.inspectSourceDiff.output), { patterns: 'apply' });
    assert.equal(Schema.decodeUnknownResult(Schema.toType(schema), { onExcessProperty: 'error' })(result)._tag === 'Success', valid);
    assert.equal((() => { try { decodeOperationOutput('inspectSourceDiff', result); return true; } catch { return false; } })(), valid);
  }
});

test('source decisions retain equivalent strict SHA/reset JSON contracts and kind-paired durable evidence', () => {
  const change={kind:'sourceDecision',sourceId:'Owner/Repo',action:'pin',revision:'a'.repeat(40)};
  for(const [selected,valid] of [[change,true],[{...change,revision:'a'.repeat(40)+'\n'},false],[{...change,revision:'A'.repeat(40)},false],[{...change,revision:'a'.repeat(64)},false],[{...change,path:'/private'},false],[{...change,action:'unpin'},false],[{kind:'sourceDecision',sourceId:'Owner/Repo',action:'unpin'},true]] as const) {
    assert.equal(acceptsOperation('previewChange',{change:selected}),valid);assert.equal(acceptsJsonInput('previewChange',{change:selected}),valid);
  }
  const author={checkout:'/author',realCheckout:'/author',gitDir:'/author/.git',head:'c'.repeat(40),files:[{path:'skill-pins.json',kind:'file',sha256:'d'.repeat(64),indexBlob:'e'.repeat(64)}]};
  const parity={kind:'sourceDecision',generation:'1',baselineDigest:'b'.repeat(64),planDigest:'c'.repeat(64),plannedKeys:['source:Owner/Repo/pin'],author,sourceId:'Owner/Repo',observedRevision:'f'.repeat(40)};
  const receipt={...run,intent:{...run.intent,change,parity},parity:{kind:'sourceDecision',state:'needsInspection',committedKeys:[],remainingKeys:parity.plannedKeys,backupIds:[]}};
  assert.equal(decodeRunView(receipt).intent.change.kind,'sourceDecision');
  assert.equal(decodeRunView({...receipt,intent:{...receipt.intent,change:{kind:'sourceDecision',sourceId:'Owner/Repo',action:'unignore'},parity:{...parity,observedRevision:'f'.repeat(64)}}}).intent.change.kind,'sourceDecision');
  for(const bad of [{...receipt,intent:{...receipt.intent,parity:{...parity,kind:'capture'}}},{...receipt,parity:{...receipt.parity,kind:'syncDecision'}},{...receipt,intent:{...receipt.intent,parity:{...parity,sourcePath:'/private'}}}])assert.throws(()=>decodeRunView(bad));
});

test('History diagnostic schemas accept only paired outcome summaries and closed pause facts', () => {
  const base={at:'2026-10-15T00:00:00.000Z',actor:'agent'};
  const result=(event:unknown)=>({events:[event],nextBefore:null});
  for(const [outcome,note] of [['ok','Step completed'],['failed','Step failed'],['cancelled','Step cancelled']]) {
    const event={...base,kind:'apply-finished',steps:[{key:'config:one',outcome,note}]};
    assert.doesNotThrow(()=>decodeOperationOutput('history',result(event)));
    assert.throws(()=>decodeOperationOutput('history',result({...event,steps:[{key:'config:one',outcome,note:'password=fixture-only-value'}]})));
  }
  assert.throws(()=>decodeOperationOutput('history',result({...base,kind:'apply-finished',steps:[{key:'config:one',outcome:'failed',note:'Step completed'}]})));
  for(const [kind,reason] of [['paused','Automatic application paused'],['resumed','Application pause cleared']]) {
    assert.doesNotThrow(()=>decodeOperationOutput('history',result({...base,kind,detail:{kind:'pause',reason}})));
    assert.throws(()=>decodeOperationOutput('history',result({...base,kind,detail:{kind:'pause',reason:'password=fixture-only-value'}})));
  }
});

test('semantic discovery notifications contain only a bounded run ID', () => {
  const event = { version: 3, event: 'operation-run', runId: 'r' };
  assert.deepEqual(decodeMessage(event), event);
  for (const fields of [{ runId: '' }, {runId:'x'.repeat(101)}, {userCode:'SECRET'}, {signInFlow:'private'}, {receipt:run}]) assert.throws(() => decodeMessage({...event,...fields}));
});

// Every decoded wire variant must remain assignable to the public message contract.
const publicMessage = (decoded: ReturnType<typeof decodeMessage>): Message => decoded;
test('semantic notification is part of the exported Message contract', () => {
  assert.deepEqual(publicMessage(decodeMessage({ version: 3, event: 'operation-run', runId: 'r' })), { version: 3, event: 'operation-run', runId: 'r' });
});
