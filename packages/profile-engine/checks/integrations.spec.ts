import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntegrations, referencedFiles } from '../src/integrations.ts';

const plugin = { id: 'sp', label: 'superpowers', target: 'claude', type: 'plugin', default: true, plugin: 'superpowers@x' };
const hook = { id: 'h', label: 'hook', target: 'claude', type: 'hook', default: false, event: 'Stop', file: 'hooks/h.sh' };
const doc = (integrations: unknown[], extra: object = {}) => JSON.stringify({ version: 1, integrations, ...extra });
const none = () => false;

test('accepts valid declarations and the allow list', () => {
  const parsed = parseIntegrations(doc([plugin, hook], { allow: { plugins: ['a@b'] } }), (f) => f === 'hooks/h.sh');
  assert.deepEqual(parsed, { integrations: [plugin, hook], allow: { plugins: ['a@b'] }, issues: [] });
});

test('an absent document declares nothing', () => {
  assert.deepEqual(parseIntegrations(undefined, none), { integrations: [], allow: {}, issues: [] });
});

test('any refusal yields no integrations and no allow list', () => {
  const refused: Array<[string, string]> = [
    ['invalid json', '{'],
    ['not an object', '[]'],
    ['wrong version', JSON.stringify({ version: 2, integrations: [] })],
    ['no integrations array', JSON.stringify({ version: 1 })],
    ['item not an object', doc(['x'])],
    ['missing id', doc([{ ...plugin, id: '' }])],
    ['duplicate id', doc([plugin, plugin])],
    ['missing label', doc([{ ...plugin, label: '' }])],
    ['unsupported target', doc([{ ...plugin, target: 'cursor' }])],
    ['unknown type', doc([{ ...plugin, type: 'widget' }])],
    ['default not boolean', doc([{ ...plugin, default: 'yes' }])],
    ['plugin without name', doc([{ ...plugin, plugin: '' }])],
    ['marketplace without source', doc([{ id: 'm', label: 'm', target: 'claude', type: 'marketplace', default: true, name: 'm' }])],
    ['marketplace without name', doc([{ id: 'm', label: 'm', target: 'claude', type: 'marketplace', default: true, marketplace: 'o/r' }])],
    ['mcp without command', doc([{ id: 'c', label: 'c', target: 'codex', type: 'mcp', default: true }])],
    ['mcp for claude', doc([{ id: 'c', label: 'c', target: 'claude', type: 'mcp', default: true, command: 'c' }])],
    ['hook without event', doc([{ ...hook, event: '' }])],
    ['hook without file', doc([{ ...hook, file: '' }])],
    ['hook file not in repo', doc([hook])],
    ['requiresEnv not names', doc([{ ...plugin, requiresEnv: [1] }])],
    ['secret field name', doc([{ ...plugin, token: 'x' }])],
    ['secret value', doc([{ ...plugin, note: 'sk-abcdef12' }])],
    ['secret value in a list', doc([{ ...plugin, args: ['ok', 'ghp_abcdefgh1'] }])],
    ['allow not an object', doc([plugin], { allow: [] })],
    ['allow unknown category', doc([plugin], { allow: { widgets: [] } })],
    ['allow not ids', doc([plugin], { allow: { plugins: [''] } })],
  ];
  for (const [name, text] of refused) {
    const parsed = parseIntegrations(text, none);
    assert.deepEqual(parsed.integrations, [], name);
    assert.deepEqual(parsed.allow, {}, name);
    assert.ok(parsed.issues.length > 0, name);
    assert.ok(parsed.issues.every((i) => i.layer === 'base' && i.source === 'integrations.json'), name);
  }
});

test('requiresEnv is a list of names, never scanned as values', () => {
  const parsed = parseIntegrations(doc([{ ...plugin, requiresEnv: ['API_KEY'] }]), none);
  assert.deepEqual(parsed.issues, []);
});

test('referencedFiles lists hook files so a loader can check them', () => {
  assert.deepEqual(referencedFiles(doc([plugin, hook, { ...hook, id: 'h2', file: 5 }])), ['hooks/h.sh']);
  assert.deepEqual(referencedFiles(undefined), []);
  assert.deepEqual(referencedFiles('{'), []);
});
