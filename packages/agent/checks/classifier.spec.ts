import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, INERT_KEYS, type Change, type Entry, type HeldReason, type Verdict } from '../src/index.ts';

const INERT: Verdict = { kind: 'inert' };
const held = (reason: HeldReason): Verdict => ({ kind: 'held', reason });

const md = (over: Partial<Extract<Entry, { kind: 'file' }>> = {}): Entry =>
  ({ kind: 'file', fileId: 'claude:CLAUDE.md', mode: 'copy', dest: 'CLAUDE.md', managed: true, hash: 'sha256:1', ...over });
const toml = (over: Partial<Extract<Entry, { kind: 'file' }>> = {}): Entry =>
  ({ kind: 'file', fileId: 'codex:config.toml', mode: 'copy', dest: 'config.toml', managed: true, hash: 'sha256:1', ...over });
const setting = (key: string, value: unknown = 'x', over: Partial<Extract<Entry, { kind: 'setting' }>> = {}): Entry =>
  ({ kind: 'setting', fileId: 'claude:settings.json', key, managed: true, value, ...over });
const skill = (pin: string): Entry => ({ kind: 'skill', value: { install: true, pin } });
const integration = (enabled: boolean): Entry => ({ kind: 'integration', value: { enabled } });

const rows: ReadonlyArray<readonly [string, Omit<Change, 'itemId'>, Verdict]> = [
  ['instruction file added', { after: md() }, INERT],
  ['instruction file changed', { before: md({ hash: 'sha256:0' }), after: md() }, INERT],
  ['instruction file removed', { before: md() }, held('instruction file removed or no longer managed')],
  ['instruction file no longer managed', { before: md(), after: md({ managed: false }) }, held('instruction file removed or no longer managed')],
  ['instruction file missing from the revision', { before: md(), after: md({ hash: undefined }) }, held('instruction file removed or no longer managed')],
  ['other copied file added', { after: toml() }, held('copied file can declare commands')],
  ['other copied file changed', { before: toml(), after: toml({ hash: 'sha256:2' }) }, held('copied file can declare commands')],
  ['other copied file removed', { before: toml() }, held('copied file can declare commands')],
  ...INERT_KEYS['claude:settings.json']!.flatMap((key) => [
    [`inert key ${key} added`, { after: setting(key) }, INERT] as const,
    [`inert key ${key} changed`, { before: setting(key, 'a'), after: setting(key, 'b') }, INERT] as const,
    [`inert key ${key} removed`, { before: setting(key) }, held('settings key removed')] as const,
  ]),
  ['inert key no longer managed', { before: setting('theme'), after: setting('theme', 'x', { managed: false }) }, held('settings key removed')],
  ['nested object under an unlisted key', { after: setting('worktree', { symlinkDirectories: ['node_modules'] }) }, held('settings key not known to be inert')],
  ['hooks key', { after: setting('hooks', {}) }, held('settings key not known to be inert')],
  ['env key', { after: setting('env', { A: '1' }) }, held('settings key not known to be inert')],
  ['statusLine key', { after: setting('statusLine', {}) }, held('settings key not known to be inert')],
  ['a prototype name as a key', { after: setting('constructor') }, held('settings key not known to be inert')],
  ['inert key name in a file without a table', { after: setting('theme', 'x', { fileId: 'codex:settings.json' }) }, held('settings key not known to be inert')],
  ['skill added', { after: skill('a') }, held('skill')],
  ['skill pin moved', { before: skill('a'), after: skill('b') }, held('skill')],
  ['skill removed', { before: skill('a') }, held('skill')],
  ['integration added', { after: integration(true) }, held('integration')],
  ['integration changed', { before: integration(false), after: integration(true) }, held('integration')],
  ['integration removed', { before: integration(true) }, held('integration')],
  ['kind changed between revisions', { before: md(), after: setting('theme') }, held('not a known item')],
  ['unknown kind', { after: { kind: 'mystery' } as unknown as Entry }, held('not a known item')],
  ['nothing on either side', {}, held('not a known item')],
];

for (const [name, change, verdict] of rows) {
  test(`classify: ${name}`, () => {
    assert.deepEqual(classify({ itemId: 'x', ...change }), verdict);
  });
}

test('INERT_KEYS is the reviewed table; widening it needs a new row here', () => {
  assert.deepEqual(INERT_KEYS, { 'claude:settings.json': ['attribution', 'effortLevel', 'model', 'outputStyle', 'theme', 'tui'] });
});
