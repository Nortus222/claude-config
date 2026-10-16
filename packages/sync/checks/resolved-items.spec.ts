import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProfileInvalid, resolveNamedProfile } from '@nortuscc/profile-engine';
import * as sync from '../src/index.ts';
import { BASE, json, runSync, tempRepo } from './support/repo.ts';

const FILE = 'file:claude:CLAUDE.md';
const SKILL = 'skill:mattpocock/skills/tdd';
const profiles = {
  ...BASE,
  'profiles/base.json': json({}),
  'profiles/child.json': json({ extends: 'base' }),
  'profiles/other.json': json({}),
  'claude/personal.md': '# personal\n',
};
const values = (documents: Readonly<Record<string, string>>, name = 'child') =>
  sync.resolvedItemValues(resolveNamedProfile({ documents, name }), documents);

test('a parent-only change is incoming for a child profile', async () => {
  const repo = tempRepo(profiles);
  const head = repo.commit({ 'profiles/base.json': json({ files: { 'claude:CLAUDE.md': 'claude/personal.md' } }) });
  const result = await runSync(sync.incoming({ repo: repo.dir, applied: repo.first, head, holds: {}, overrides: {}, profile: 'child' }));
  assert.deepEqual(result.changes.map(c => c.itemId), [FILE]);
});

test('a change to an unrelated profile produces no incoming items', async () => {
  const repo = tempRepo(profiles);
  const head = repo.commit({ 'profiles/other.json': json({ skills: { remove: [{ source: 'mattpocock/skills', names: ['tdd'] }] } }) });
  const result = await runSync(sync.incoming({ repo: repo.dir, applied: repo.first, head, holds: {}, overrides: {}, profile: 'child' }));
  assert.deepEqual(result.changes, []);
});

test('a machine override does not hide an incoming change', async () => {
  const repo = tempRepo(profiles);
  const head = repo.commit({ 'profiles/base.json': json({ skills: { remove: [{ source: 'mattpocock/skills', names: ['tdd'] }] } }) });
  const result = await runSync(sync.incoming({ repo: repo.dir, applied: repo.first, head, holds: {}, overrides: { skills: { tdd: false } }, profile: 'child' }));
  assert.deepEqual(result.changes.map(c => c.itemId), [SKILL]);
  assert.deepEqual(result.conflicts, [{ itemId: SKILL, override: 'skills.tdd' }]);
});

test("a hold keeps the held commit's value under the followed profile", async () => {
  const repo = tempRepo({ ...profiles, 'profiles/base.json': json({ files: { 'claude:CLAUDE.md': 'claude/personal.md' } }) });
  const head = repo.commit({ 'profiles/base.json': json({ files: { 'claude:CLAUDE.md': null }, integrations: { remove: ['hk'] }, skills: { remove: [{ source: 'mattpocock/skills', names: ['tdd'] }] } }) });
  const snapshot = await runSync(sync.desiredFor({ repo: repo.dir, head: { kind: 'commit', commit: head }, profile: 'child', held: { [FILE]: repo.first, [SKILL]: repo.first, 'integration:hk': repo.first }, into: join(repo.root, 'snapshot') }));
  assert.equal(snapshot.desired.files.find(f => f.id === 'claude:CLAUDE.md')!.managed, true);
  const file = snapshot.desired.files.find(f => f.id === 'claude:CLAUDE.md')!;
  assert.equal(readFileSync(join(snapshot.repo, file.src), 'utf8'), '# personal\n');
  assert.equal(snapshot.desired.skills.find(s => s.name === 'tdd')!.install, true);
  assert.equal(snapshot.desired.integrations.find(i => i.id === 'hk')!.enabled, true);
});

test('droppedOnSwitch lists holds and overrides for items missing from the new profile', () => {
  const to = resolveNamedProfile({ documents: profiles, name: 'child' });
  assert.deepEqual(sync.droppedOnSwitch({ to, holds: { [FILE]: 'a', 'integration:gone': 'b' }, overrides: {
    manageConfig: false, configTargets: ['codex'], skillAdditions: [{ source: 'a/b', name: 'mine', targets: ['codex'] }],
    settings: { 'claude:settings.json': { theme: 'dark', gone: true } }, skills: { tdd: false, gone: true }, integrations: { hk: false, gone: true },
  } }), { holds: ['integration:gone'], overrides: ['integrations.gone', 'settings.claude:settings.json.gone', 'skills.gone'] });
});

test('resolved values include enablement and referenced hook bytes but ignore provenance', () => {
  const changed = { ...profiles, 'profiles/base.json': json({ integrations: { remove: ['hk'] }, skills: { remove: [{ source: 'mattpocock/skills', names: ['tdd'] }] }, files: { 'claude:CLAUDE.md': null } }) };
  assert.deepEqual(sync.diffItems(values(profiles), values(changed)).map(c => c.itemId), [FILE, 'integration:hk', SKILL]);
  assert.deepEqual(sync.diffItems(values(profiles), values({ ...profiles, 'claude/hooks/hk.mjs': '// changed\n' })).map(c => c.itemId), ['integration:hk']);
  assert.deepEqual(sync.diffItems(values(profiles), values({ ...profiles, 'profiles/child.json': json({ extends: 'base', integrations: { add: ['hk'] } }) })), []);
});

test('snapshot keys separate repository and profile identity at the same commit', () => {
  const key = { commit: 'a'.repeat(40), held: {}, repoUrl: 'https://github.com/a/b', profile: 'child' };
  assert.notEqual(sync.snapshotKey(key), sync.snapshotKey({ ...key, profile: 'other' }));
  assert.notEqual(sync.snapshotKey(key), sync.snapshotKey({ ...key, repoUrl: 'https://github.com/a/c' }));
  assert.equal(sync.SNAPSHOT_FORMAT, 2);
});

test('a default-profile hook hold keeps its referenced bytes over a changed head file', async () => {
  const repo = tempRepo();
  const head = repo.commit({ 'claude/hooks/hk.mjs': '// changed\n' });
  const snapshot = await runSync(sync.desiredFor({ repo: repo.dir, profile: 'default', head: { kind: 'commit', commit: head }, held: { 'integration:hk': repo.first }, into: join(repo.root, 'held-hook') }));
  assert.equal(readFileSync(join(snapshot.repo, 'claude/hooks/hk.mjs'), 'utf8'), BASE['claude/hooks/hk.mjs']);
});

test('a hold on an item absent at the held profile revision removes a later profile addition', async () => {
  const repo = tempRepo(profiles);
  const head = repo.commit({ 'profiles/base.json': json({ skills: { add: [{ source: 'example/skills', names: ['new'] }] } }) });
  const snapshot = await runSync(sync.desiredFor({ repo: repo.dir, profile: 'child', head: { kind: 'commit', commit: head }, held: { 'skill:example/skills/new': repo.first }, into: join(repo.root, 'absent-skill') }));
  assert.equal(snapshot.desired.skills.some(skill => skill.name === 'new'), false);
});

test('a settings hold reads the replacement document selected by the held profile', async () => {
  const repo = tempRepo({ ...profiles, 'profiles/base.json': json({ files: { 'claude:settings.json': 'claude/personal.keys.json' } }), 'claude/personal.keys.json': json({ theme: 'dark' }) });
  const head = repo.commit({ 'profiles/base.json': json({}) });
  const snapshot = await runSync(sync.desiredFor({ repo: repo.dir, profile: 'child', head: { kind: 'commit', commit: head }, held: { 'setting:claude:settings.json#theme': repo.first }, into: join(repo.root, 'held-setting') }));
  assert.equal(snapshot.desired.files.find(file => file.id === 'claude:settings.json')!.keys!.theme!.value, 'dark');
});

test('a hold cannot invent a followed profile missing at its held commit', async () => {
  const repo = tempRepo();
  const head = repo.commit({ 'profiles/child.json': '{}' });
  await assert.rejects(runSync(sync.desiredFor({ repo: repo.dir, profile: 'child', head: { kind: 'commit', commit: head }, held: { [FILE]: repo.first }, into: join(repo.root, 'missing-held-profile') })), (error: unknown) => error instanceof ProfileInvalid && error.issues.some(issue => issue.message.includes('missing profile')));
});

test('profile exclusions retain existing holds and item overrides during a switch', () => {
  const to = resolveNamedProfile({ name: 'child', documents: { ...profiles, 'profiles/child.json': json({ files: { 'claude:CLAUDE.md': null }, skills: { remove: [{ source: 'mattpocock/skills', names: ['tdd'] }] }, integrations: { remove: ['hk'] } }) } });
  assert.deepEqual(sync.droppedOnSwitch({ to, holds: { [FILE]: 'a', [SKILL]: 'a', 'integration:hk': 'a' }, overrides: { skills: { tdd: true }, integrations: { hk: true } } }), { holds: [], overrides: [] });
});
