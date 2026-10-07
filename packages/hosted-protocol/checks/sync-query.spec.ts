import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSyncQuery, formatSyncQuery } from '../src/index.ts';

test('sync query defaults and canonical setup sorting', () => {
  assert.deepEqual(parseSyncQuery(new URLSearchParams()), { since: 0, setups: [] });
  assert.deepEqual(parseSyncQuery(new URLSearchParams('setups=')), { since: 0, setups: [] });
  const query = parseSyncQuery(new URLSearchParams('since=42&setups=z:12,a:0'));
  assert.deepEqual(query, { since: 42, setups: [{ setupId: 'z', revision: 12 }, { setupId: 'a', revision: 0 }] });
  const formatted = formatSyncQuery(query);
  assert.equal(formatted.get('since'), '42');
  assert.equal(formatted.get('setups'), 'a:0,z:12');
  assert.deepEqual(parseSyncQuery(formatted), { since: 42, setups: [{ setupId: 'a', revision: 0 }, { setupId: 'z', revision: 12 }] });
  assert.equal(formatSyncQuery({ since: 0, setups: [] }).toString(), 'since=0');
  const mixed = { since: 0, setups: [{ setupId: 'a', revision: 0 }, { setupId: 'Z', revision: 0 }, { setupId: 'A', revision: 0 }] };
  assert.equal(formatSyncQuery(mixed).get('setups'), 'A:0,Z:0,a:0');
  assert.deepEqual(mixed.setups.map((setup) => setup.setupId), ['a', 'Z', 'A']);
});

test('sync query rejects unknown, duplicate, unsafe and malformed cursor fields', () => {
  for (const query of ['extra=SECRET', 'since=0&since=1', 'setups=a:0&setups=b:0', 'since=', 'since=-1', 'since=1.1', 'since=1e2', 'since=01', 'since=9007199254740992', 'setups=a:0,a:1', 'setups=local:0', 'setups=a:-1', 'setups=a:1.1', 'setups=a:9007199254740992', 'setups=a:0,', 'setups=a:0:1', `setups=${Array.from({ length: 11 }, (_, i) => `a${i}:0`).join(',')}`]) assert.throws(() => parseSyncQuery(new URLSearchParams(query)), { message: 'Invalid hosted payload' });
  assert.throws(() => formatSyncQuery({ since: 0, setups: [{ setupId: 'a', revision: 0 }, { setupId: 'a', revision: 1 }] }));
});
