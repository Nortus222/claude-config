import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from 'effect';
import {
  operationDefinitions, operationJsonSchemas, decodeOperationInput, decodeOperationOutput,
  decodeOperationScope, decodeContextResult, decodeRunView, projectContext, capabilityInventory,
} from '../src/operations/index.ts';
import { InspectResultSchema, PreviewResultSchema, decodeInspectResult, decodePreviewResult, decodeMessage } from '../src/ipc/protocol.ts';

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
  const inputs = { getContext: {}, inspect: {}, previewChange: { change }, applyChange: { planId: 'p', requestId: 'q' }, getRun: { runId: 'r' }, listRuns: { limit: 10 }, cancelRun: { runId: 'r' }, history: { limit: 10 } };
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
  for (const name of ['addSkill', 'shareWithMyMachines', 'promoteToProfile']) {
    const state = capabilityInventory[name as keyof typeof capabilityInventory];
    assert.equal(state.available, false);
    assert.ok('reason' in state && state.reason.length > 0);
    assert.equal(name in operationDefinitions, false);
  }
  assert.deepEqual(Object.keys(operationDefinitions), ['getContext', 'inspect', 'previewChange', 'applyChange', 'getRun', 'listRuns', 'cancelRun', 'history']);
  for (const [name, definition] of Object.entries(operationDefinitions)) {
    assert.equal(definition.name, name);
    assert.deepEqual(definition.scopes, ['machine']);
    assert.equal(definition.mutation, name === 'applyChange' || name === 'cancelRun');
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

test('legacy IPC result schemas are shared with the operation definitions', () => {
  assert.equal(operationDefinitions.inspect.output, InspectResultSchema);
  assert.equal(operationDefinitions.previewChange.output.fields.plan, PreviewResultSchema.fields.plan);
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
  assert.equal(input.properties.change.additionalProperties, false);
  assert.deepEqual(input.properties.change.properties.kind.enum, ['reconcile']);
  assert.equal(input.properties.change.properties.only.maxItems, 10_000);
  assert.equal(input.properties.change.properties.only.items.maxLength, 500);
  const inspectOutput = operationJsonSchemas.inspect.output as any;
  assert.equal(inspectOutput.properties.items.items.properties.note.type, 'string');
  assert.throws(() => decodeOperationOutput('inspect', { profile: { repo: '/r', revision: null, overrides: '/o', issues: [] }, items: [{ key: 'k', domain: 'skills', label: 'x', group: 'x', state: 'missing', disposition: 'apply', note: null }], probeErrors: [] }));
  const history = operationJsonSchemas.history.input as any;
  assert.ok(history.properties.before.properties.at.pattern);
  assert.equal(history.properties.before.properties.seq.maximum, Number.MAX_SAFE_INTEGER);
  const run = operationJsonSchemas.getRun.output as any;
  assert.equal(run.properties.intent.properties.inputDigest.pattern, '^[0-9a-f]{64}$');
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
