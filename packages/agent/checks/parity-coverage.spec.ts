import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { engineCapabilityCoverage, assertCapabilityCoverage } from '../src/operations/coverage.ts';
import { operationDefinitions, operationJsonSchemas, capabilityInventory, decodeOperationOutput } from '../src/operations/index.ts';

const reads = ['authorProfiles','machineFile','authorFile','upstreams','discoverUpstream','upstreamSkill','drafts','draftPreview','ghState','getContext', 'inspect', 'inspectIntent', 'inspectUpdates', 'resolveSkillCandidate', 'inspectSetups', 'incomingChanges', 'prepareTrustRequest', 'watchSources', 'inspectSourceDiff', 'pinImpact', 'draftChangelog', 'agentStatus', 'accountState', 'listBackups', 'getRun', 'listRuns', 'history'];
const changes = ['reconcile', 'machineIntent', 'editDraft', 'removeDraftIntent', 'deleteDraft', 'ghLogin', 'publishDraft', 'announcePublication', 'uninstallConfig', 'update', 'setupApply', 'syncDecision', 'setPolicy', 'resume', 'signIn', 'signOut', 'syncAccount', 'patchMachineMetadata', 'pruneBackups', 'addSkill'];

test('original owner inventory maps dedicated reads and every supported change to actual handlers', () => {
  const rows = Object.values(engineCapabilityCoverage);
  const available = rows.filter(row => row.state === 'available');
  const mapped = new Set(available.flatMap(row => row.operations));
  for (const name of reads) assert.ok(mapped.has(name as keyof typeof operationDefinitions), name);
  assert.deepEqual([...new Set(available.flatMap(row => 'changes' in row ? row.changes as string[] : []))].sort(), changes.sort());
  const changeSchema = operationJsonSchemas.previewChange.input as { properties: { change: { anyOf: { properties: {kind: {enum: string[]}} }[] } } };
  assert.deepEqual([...new Set(changeSchema.properties.change.anyOf.flatMap(change => change.properties.kind.enum))].sort(), [...changes, 'capture', 'sourceDecision'].sort());
  const server = readFileSync(new URL('../src/ipc/server.ts', import.meta.url), 'utf8');
  for (const name of Object.keys(operationDefinitions)) assert.ok(server.includes(`case '${name}':`), name);
  assert.ok(rows.some(row => row.state !== 'available' && /user.*pause/i.test(row.reason)));
  assert.ok(rows.some(row => row.state !== 'available' && /standalone.*pull/i.test(row.reason)));
});

test('coverage rejects missing dedicated reads and falsely advertised prerequisites', () => {
  const input = { operations: Object.keys(operationDefinitions), capabilities: capabilityInventory };
  for (const name of reads) assert.throws(() => assertCapabilityCoverage({ ...input, operations: input.operations.filter(item => item !== name) }), new RegExp(name));
  for (const name of ['shareWithMyMachines', 'promoteToProfile']) assert.throws(() => assertCapabilityCoverage({ ...input, capabilities: { ...capabilityInventory, [name]: { available: true } } }), new RegExp(name));
});

test('safe public History cannot acquire raw private payload fields', () => {
  const safe = { events: [{at:'2026-10-15T00:00:00Z',actor:'mcp',kind:'unknown',message:'Unsupported historical event'}], nextBefore:null };
  assert.deepEqual(decodeOperationOutput('history',safe),safe);
  for(const field of ['token','userCode','pendingId','signInFlow','receipt','payload'])assert.throws(()=>decodeOperationOutput('history',{...safe,events:[{...safe.events[0],[field]:'private'}]}));
});
