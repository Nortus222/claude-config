import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DisplayNameSchema, decodeHosted } from '@nortuscc/hosted-protocol';
// @ts-expect-error Plain Node generator has no TypeScript declarations.
import { displayNameCategories } from '../scripts/display-name-categories.mjs';

test('native name categories reproduce the shared Unicode predicates at every code point', async () => {
  const source = await readFile(new URL('../src-tauri/src/display_name_categories.rs', import.meta.url), 'utf8');
  assert.equal(source, displayNameCategories(), 'regenerate with the documented Node runtime when deliberately changing Unicode');
  const tables = [...source.matchAll(/const (\w+): &\[\(u32,u32\)\] = &\[([\s\S]*?)\];/g)]
    .map(([, , text]) => [...text!.matchAll(/\(0x([0-9a-f]+),0x([0-9a-f]+)\)/g)].map(([, lo, hi]) => [parseInt(lo!, 16), parseInt(hi!, 16)] as const));
  assert.equal(tables.length, 2);
  const offsets = [0, 0];
  for (let code = 0; code <= 0x10ffff; code++) {
    const actual = tables.map((ranges, index) => {
      while (offsets[index]! < ranges.length && ranges[offsets[index]!]![1] < code) offsets[index]!++;
      const range = ranges[offsets[index]!]; return !!range && range[0] <= code;
    });
    const char = String.fromCodePoint(code);
    assert.equal(actual[0], /[\p{C}\p{Zl}\p{Zp}]/u.test(char), `disallowed ${code.toString(16)}`);
    assert.equal(actual[1], /[\p{M}\p{Z}]/u.test(char), `visible-content exclusion ${code.toString(16)}`);
  }
  for (const name of ['My Mac', 'é', '😀'.repeat(100)]) assert.equal(decodeHosted(DisplayNameSchema, name), name);
  for (const name of ['', 'bad\u200bname', 'bad\u0378name', '\u0301', '😀'.repeat(101)]) assert.throws(() => decodeHosted(DisplayNameSchema, name));
});
