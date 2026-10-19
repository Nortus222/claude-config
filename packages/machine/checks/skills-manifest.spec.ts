import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResolvedSkill } from '@nortuscc/profile-engine';
import { emitManifest, groupsFromLock, groupsOf, installedGroups, manifestOutcome, sourceOf } from '../src/index.ts';

const g = (source: string, skills: string[], extra: { exact?: boolean; optional?: boolean } = {}) =>
  ({ source, skills, exact: extra.exact ?? false, optional: extra.optional ?? false });
const skill = (name: string, source: string, extra: Partial<ResolvedSkill> = {}): ResolvedSkill =>
  ({ name, source, exact: false, optional: false, install: true, from: { layer: 'base', source: 'skills-manifest.txt' }, ...extra });
const meta = (source: string) => ({ source, sourceUrl: `https://github.com/${source}.git`, skillPath: 'x/SKILL.md' });

test('emitManifest writes the legacy header and markers byte for byte', () => {
  assert.equal(emitManifest([g('a/b', ['x', 'y'], { exact: true }), g('c/d', ['z'], { optional: true })]),
    '# Shared and optional skills, grouped by the repo they install from.\n'
    + '# Regenerate with: nortuscc capture\n'
    + '# Install with:    nortuscc apply --install\n'
    + "# A source marked 'exact' is limited to the skills listed under it.\n"
    + '# A source marked optional is offered unchecked and only installed when selected.\n\n'
    + '[a/b] exact\nx\ny\n\n[c/d] optional\nz\n');
});

test('emitManifest writes both markers in exact-then-optional order', () => {
  assert.match(emitManifest([g('p/s', ['k'], { exact: true, optional: true })]), /^\[p\/s\] exact optional\nk\n$/m);
});

test('groupsOf regroups resolved skills by source in first-seen order', () => {
  assert.deepEqual(groupsOf([skill('x', 'a/b', { exact: true }), skill('z', 'c/d'), skill('y', 'a/b', { exact: true })]),
    [g('a/b', ['x', 'y'], { exact: true }), g('c/d', ['z'])]);
});

test('sourceOf accepts only a non-empty string source', () => {
  assert.equal(sourceOf({ source: 'a/b' }), 'a/b');
  for (const bad of [{}, { source: 5 }, { source: '' }, 'x', null, undefined, [], 7]) assert.equal(sourceOf(bad), null);
});

test('groupsFromLock derives sources and sorts deterministically', () => {
  const lock = { skills: {
    teach: { source: 'mattpocock/skills' }, explain: { source: 'Nortus222/agent-skills' },
    'grill-me': { source: 'mattpocock/skills' }, scratch: {},
  } };
  assert.deepEqual(groupsFromLock(lock), [g('Nortus222/agent-skills', ['explain']), g('mattpocock/skills', ['grill-me', 'teach'])]);
});

test('groupsFromLock ignores entries without a string source and sorts by code point', () => {
  assert.deepEqual(groupsFromLock({ skills: { b: { source: 'z/z' }, a: { source: 'B/b' }, c: { source: 5 }, d: 'x' } }),
    [g('B/b', ['a']), g('z/z', ['b'])]);
});

test('a non-string source is not a source', () => {
  assert.deepEqual(groupsFromLock({ skills: { odd: { source: 5 } } }), []);
});

test('groupsFromLock tolerates malformed entries', () => {
  assert.deepEqual(groupsFromLock({ skills: { a: null, b: 'nope', c: [], d: 3 } }), []);
});

test('installedGroups keeps exact markers, drops uninstalled names and retains optional declarations', () => {
  const lock = { skills: { x: { source: 'a/b' }, gone: { source: 'a/b' }, o: { source: 'o/p' } } };
  assert.deepEqual(installedGroups(lock, ['x', 'o'], [g('a/b', ['x'], { exact: true }), g('o/p', ['o', 'later'], { optional: true })]),
    [g('a/b', ['x'], { exact: true }), g('o/p', ['later', 'o'], { optional: true })]);
});

test('capture preserves optional declarations when the machine has not opted in', () => {
  const groups = installedGroups({ skills: { public: { source: 'public/skills' } } }, ['public'],
    [g('private/skills', ['private'], { exact: true, optional: true })]);
  assert.deepEqual(groups, [g('private/skills', ['private'], { exact: true, optional: true }), g('public/skills', ['public'])]);
});

test('regenerating the manifest carries the exact marker across', () => {
  const lock = { skills: { unslop: { source: 'cursor/plugins' }, tdd: { source: 'm/s' } } };
  assert.deepEqual(installedGroups(lock, ['unslop', 'tdd'], [g('cursor/plugins', ['unslop'], { exact: true })]),
    [g('cursor/plugins', ['unslop'], { exact: true }), g('m/s', ['tdd'])]);
  assert.equal(installedGroups(lock, ['unslop', 'tdd'])[0]?.exact, false, 'with no manifest to consult nothing is pinned');
});

test('installedGroups keeps a skill whose folder is present', () => {
  assert.deepEqual(installedGroups({ skills: { tdd: meta('o/r') } }, ['tdd']), [g('o/r', ['tdd'])]);
});

test('installedGroups drops a lock entry whose folder is gone', () => {
  assert.deepEqual(installedGroups({ skills: { tdd: meta('o/r'), ghost: meta('o/r') } }, ['tdd']), [g('o/r', ['tdd'])]);
});

test('installedGroups drops a source group that empties', () => {
  assert.deepEqual(installedGroups({ skills: { tdd: meta('o/one'), ghost: meta('o/two') } }, ['tdd']), [g('o/one', ['tdd'])]);
});

test('installedGroups includes a newly adopted skill', () => {
  assert.deepEqual(installedGroups({ skills: { tdd: meta('o/r'), wizard: meta('o/r') } }, ['tdd', 'wizard']),
    [g('o/r', ['tdd', 'wizard'])]);
});

test('installedGroups creates a group for a source new to the manifest', () => {
  assert.deepEqual(installedGroups({ skills: { tdd: meta('o/one'), fresh: meta('o/new') } }, ['tdd', 'fresh']),
    [g('o/new', ['fresh']), g('o/one', ['tdd'])]);
});

test('installedGroups ignores a skill on disk with no lock entry', () => {
  assert.deepEqual(installedGroups({ skills: { tdd: meta('o/r') } }, ['tdd', 'mine']), [g('o/r', ['tdd'])]);
});

test('installedGroups on malformed lock entries is empty rather than throwing', () => {
  assert.deepEqual(installedGroups({ skills: { tdd: null, wizard: 'nope' } }, ['tdd', 'wizard']), []);
  assert.deepEqual(installedGroups({ skills: {} }, ['tdd']), []);
});

// The installer treats skill names case-insensitively and may record a manifest `TDD` as `tdd`.
test('installedGroups keeps the manifest spelling of a skill whose lock entry and folder differ in case', () => {
  assert.deepEqual(installedGroups({ skills: { tdd: meta('o/r'), Grill: meta('o/r') } }, ['tdd', 'grill'], [g('o/r', ['TDD'])]),
    [g('o/r', ['Grill', 'TDD'])]);
  assert.deepEqual(installedGroups({ skills: { tdd: meta('o/r') } }, ['tdd'], [g('o/r', ['TDD', 'later'], { optional: true })]),
    [g('o/r', ['TDD', 'later'], { optional: true })]);
});

test('manifestOutcome counts a name that differs only in case as kept or pruned', () => {
  assert.equal(manifestOutcome({ before: [g('o/r', ['TDD', 'a'])], groups: [g('o/r', ['tdd', 'a'])] }).write, true);
  assert.equal(manifestOutcome({ before: [g('o/r', ['TDD', 'a'])], groups: [g('o/r', ['a'])], prunedNames: ['tdd'] }).write, true);
});

test('manifestOutcome writes when nothing shrank', () => {
  assert.equal(manifestOutcome({ before: [g('o/r', ['a', 'b'])], groups: [g('o/r', ['a', 'b'])], prunedNames: [] }).write, true);
});

test('manifestOutcome refuses an adopt that masks a miss', () => {
  const out = manifestOutcome({ before: [g('a/b', ['x', 'y'])], groups: [g('a/b', ['x', 'w'])] });
  assert.equal(out.write, false);
  assert.match(out.reason, /would drop 1 entr\(ies\) \(y\)/);
});

test('an adopt that exactly masks a miss is refused even when the counts match', () => {
  const out = manifestOutcome({ before: [g('o/r', ['a', 'b', 'ghost'])], groups: [g('o/r', ['a', 'b', 'wizard'])], prunedNames: [] });
  assert.equal(out.write, false);
  assert.match(out.reason, /ghost/);
});

test('manifestOutcome writes a shrink the prune explains, and refuses an empty manifest', () => {
  assert.deepEqual(manifestOutcome({ before: [g('a/b', ['x', 'y'])], groups: [g('a/b', ['x'])], prunedNames: ['y'] }),
    { write: true, reason: '1 skill(s)' });
  assert.equal(manifestOutcome({ before: [g('a/b', ['y'])], groups: [], prunedNames: ['y'] }).write, false);
});

test('manifestOutcome refuses a shrink larger than the prune, naming the unexplained entry', () => {
  const out = manifestOutcome({ before: [g('o/r', ['a', 'b', 'c'])], groups: [g('o/r', ['a'])], prunedNames: ['b'] });
  assert.equal(out.write, false);
  assert.match(out.reason, /--allow-shrink/);
  assert.match(out.reason, /\bc\b/);
});

test('manifestOutcome writes growth, a pure prune, and an adopt with no misses', () => {
  const before = [g('o/r', ['a', 'b', 'c'])];
  assert.equal(manifestOutcome({ before: [g('o/r', ['a', 'b'])], groups: [g('o/r', ['a', 'b', 'c'])], prunedNames: [] }).write, true);
  assert.equal(manifestOutcome({ before, groups: [g('o/r', ['a'])], prunedNames: ['b', 'c'] }).write, true);
  assert.equal(manifestOutcome({ before: [g('o/r', ['a', 'b'])], groups: [g('o/r', ['a', 'b', 'wizard'])] }).write, true);
});

import { updateManifestGroups, bindAuthorCheckout, prepareUpdateManifest, plan, selectAll, skillsDomain } from '../src/index.ts';
import { join } from 'node:path';
import { authorMachine } from './author-machine.ts';
const resolved = (name: string, extra: Partial<ResolvedSkill> = {}): ResolvedSkill => ({ name, source: 'o/r', exact: true, optional: false, install: true, from: { layer: 'base', source: 'skills-manifest.txt' }, ...extra });
test('routine update manifests preserve held and optional declarations without publishing additions or changing their base declaration', () => {
 const desired = [resolved('base', { targets: ['claude'], declaredFrom: { layer: 'base', source: 'skills-manifest.txt' } }), resolved('personal', { targets: ['codex'], declaredFrom: { layer: 'machine', source: 'overrides.json' } }), resolved('optional', { source: 'optional/repo', optional: true, install: false })];
 const groups = updateManifestGroups({ desired, lock: { skills: { base: { source: 'other/source' }, personal: { source: 'o/r' }, new: { source: 'o/r' } } }, installed: ['base','personal','new'], heldManifestGroups: [g('held/source',['held'])] });
 assert.deepEqual(groups.find(g => g.source === 'o/r')?.skills,['base','new']); assert.deepEqual(groups.find(g => g.source === 'optional/repo')?.skills,['optional']); assert.ok(!groups.some(g => g.skills.includes('personal'))); assert.deepEqual(groups.find(g => g.source === 'held/source')?.skills,['held']); assert.ok(!groups.some(g => g.source === 'other/source'));
});
test('author update proposal binds dirty author bytes and preserves unselected declarations with the shrink guard', async () => {
 const m = authorMachine(); m.write(join(m.paths.repo,'skills-manifest.txt'),'[o/r] exact\none\ngone\n');
 for (const name of ['one','gone']) m.write(join(m.paths.agentsSkills,name,'SKILL.md'),'# installed');
 m.write(join(m.paths.agentsSkills,'..','.skill-lock.json'),JSON.stringify({ skills: { one: { source: 'o/r' }, gone: { source: 'o/r' } } }));
 const desired = { files: [], skills: [resolved('one'),resolved('gone')], integrations: [], allow: {}, issues: [] };
 const report = { desired, probeErrors: [], items: [{ key:'skill:gone',domain:'skills' as const,label:'gone',group:'o/r',state:'gone',disposition:'apply' as const }] };
 const selected = plan('update',report,{ ...selectAll,only:['skill:gone'] },[skillsDomain]);
 const author = await m.run(bindAuthorCheckout(m.paths,['skills-manifest.txt']));
 const prepared = await m.run(prepareUpdateManifest({ author,desired,report,selected,heldManifestGroups:[g('o/r',['held'])] }));
 assert.match(prepared.documents[0]!.text,/held\none/); assert.doesNotMatch(prepared.documents[0]!.text,/gone/);
 m.write(join(m.paths.repo,'skills-manifest.txt'),'external'); await assert.rejects(m.run(prepareUpdateManifest({ author,desired,report,selected })));
});

test('routine update manifests keep the declared spelling of a skill installed under another case', () => {
 const desired = [resolved('TDD'), resolved('Personal', { declaredFrom: { layer: 'machine', source: 'overrides.json' } }), resolved('Addition', { targets: ['claude'] }), resolved('Held')];
 const lock = { skills: { tdd: { source: 'o/r' }, personal: { source: 'o/r' }, addition: { source: 'o/r' }, held: { source: 'o/r' }, gone: { source: 'o/r' } } };
 const groups = updateManifestGroups({ desired, lock, installed: ['tdd', 'personal', 'addition', 'held'], heldItemIds: ['skill:o/r/Held'] });
 assert.deepEqual(groups, [g('o/r', ['Addition', 'TDD'], { exact: true })]);
 const pruned = updateManifestGroups({ desired: [resolved('TDD'), resolved('a')], lock: { skills: { a: { source: 'o/r' } } }, installed: ['a'], prunedNames: ['tdd'] });
 assert.deepEqual(pruned, [g('o/r', ['a'], { exact: true })]);
});
