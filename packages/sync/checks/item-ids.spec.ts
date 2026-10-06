import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemIdOf } from '../src/index.ts';
import { desiredOf, hook, skill } from './support/desired.ts';

const desired = desiredOf({
  settings: { effortLevel: 'high' },
  skills: [skill('tdd', 'mattpocock/skills')],
  integrations: [hook('hk')],
});

const rows: ReadonlyArray<readonly [string, string | undefined]> = [
  ['config:claude:settings.json#effortLevel', 'setting:claude:settings.json#effortLevel'],
  ['config:claude:CLAUDE.md', 'file:claude:CLAUDE.md'],
  ['config:codex:config.toml', 'file:codex:config.toml'],
  // A whole merge-keys document (missing from the repo, unparseable here) is machine state, not an item.
  ['config:claude:settings.json', undefined],
  ['config:unknown:notes.md', undefined],
  ['skill:tdd', 'skill:mattpocock/skills/tdd'],
  // Extra or local skills are not declared, so they are not setup items.
  ['skill:ghost', undefined],
  ['skill-link:claude:tdd', undefined],
  ['integration:hk', 'integration:hk'],
  ['integration:gone', undefined],
  ['undeclared:claude:hooks:node /x.mjs', undefined],
  ['something:else', undefined],
];

for (const [key, id] of rows) {
  test(`itemIdOf maps ${key} to ${id ?? 'nothing'}`, () => {
    assert.equal(itemIdOf(key, desired), id);
  });
}
