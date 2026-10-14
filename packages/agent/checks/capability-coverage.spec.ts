import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationDefinitions, capabilityInventory, CAPABILITY_NAMES } from '../src/operations/index.ts';
import { engineCapabilityCoverage, assertCapabilityCoverage } from '../src/operations/coverage.ts';

test('every audited engine behavior has implemented operation coverage or explicit remaining ownership', () => {
  assertCapabilityCoverage({ operations: Object.keys(operationDefinitions), capabilities: capabilityInventory });
  assert.deepEqual(Object.keys(capabilityInventory).sort(), [...CAPABILITY_NAMES].sort());
  for (const coverage of Object.values(engineCapabilityCoverage)) {
    assert.ok(coverage.source.length > 0);
    if (coverage.state === 'available') assert.ok(coverage.operations.length > 0);
    else { assert.ok(coverage.workstream.length > 0); assert.ok(coverage.reason.length > 0); }
  }
});

test('a new operation or advertised capability cannot bypass coverage review', () => {
  assert.throws(() => assertCapabilityCoverage({ operations: [...Object.keys(operationDefinitions), 'newOperation'], capabilities: capabilityInventory }), /newOperation/);
  assert.throws(() => assertCapabilityCoverage({ operations: Object.keys(operationDefinitions), capabilities: { ...capabilityInventory, newCapability: { available: true } } }), /newCapability/);
  assert.throws(() => assertCapabilityCoverage({ operations: Object.keys(operationDefinitions), capabilities: { ...capabilityInventory, addSkill: { available: true } } }), /addSkill/);
});
