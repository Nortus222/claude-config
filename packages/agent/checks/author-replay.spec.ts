import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from 'effect';
import { resolveNamedProfile } from '@nortuscc/profile-engine';
import { CAPTURE_MAX_BYTES, IntentSchema } from '../src/author/intents.ts';
import { captureTargets, replay } from '../src/author/replay.ts';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const shared = {
  'profiles/base.json': '{}\n',
  'profiles/personal.json': json({ extends: 'base' }),
  'profiles/team.json': json({ extends: 'base' }),
  'claude/CLAUDE.md': 'Shared rules\n',
};

test('including a skill adds it to the profile document and nothing else changes', () => {
  const before = {
    'profiles/personal.json': json({ skills: { remove: [{ source: 'other/repo', names: [] }, { source: 'obra/superpowers', names: ['tdd', 'debug'] }] }, files: { 'codex:config.toml': null } }),
    'skills-manifest.txt': '# Unchanged\nobra/superpowers: debug\n',
  };
  const result = replay(before, [{ kind: 'includeSkill', profile: 'personal', source: 'obra/superpowers', name: 'tdd' }]);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.documents, { ...before, 'profiles/personal.json': json({ skills: { remove: [{ source: 'other/repo', names: [] }, { source: 'obra/superpowers', names: ['debug'] }], add: [{ source: 'obra/superpowers', names: ['tdd'] }] }, files: { 'codex:config.toml': null } }) });
});

test('the first created profile also writes an empty default profile', () => {
  assert.deepEqual(replay({ 'claude/CLAUDE.md': 'Rules' }, [{ kind: 'createProfile', profile: 'personal', extends: 'default' }]), {
    documents: { 'claude/CLAUDE.md': 'Rules', 'profiles/default.json': '{}\n', 'profiles/personal.json': json({ extends: 'default' }) }, invalid: [],
  });
});

test('including a skill by URL matches the manifest\'s owner/repo group', () => {
  const before = {
    'skills-manifest.txt': 'obra/superpowers: debug\n',
    'profiles/personal.json': json({ skills: { add: [{ source: 'obra/superpowers', names: ['debug'] }], remove: [{ source: 'obra/superpowers', names: ['tdd'] }] } }),
  };
  const intent = Schema.decodeUnknownSync(IntentSchema)({ kind: 'includeSkill', profile: 'personal', source: 'https://github.com/obra/superpowers', name: 'tdd' });
  const result = replay(before, [intent]);
  assert.deepEqual(result, { documents: { ...before, 'profiles/personal.json': json({ skills: { add: [{ source: 'obra/superpowers', names: ['debug', 'tdd'] }] } }) }, invalid: [] });
  const skills = resolveNamedProfile({ documents: result.documents as Record<string, string>, name: 'personal' }).skills;
  assert.deepEqual(skills.map(skill => [skill.source, skill.name, skill.install]), [['obra/superpowers', 'debug', true], ['obra/superpowers', 'tdd', true]]);
});

test('excluding a skill by URL cancels its canonical inclusion', () => {
  const before = { 'profiles/personal.json': json({ skills: { add: [{ source: 'obra/superpowers', names: ['tdd', 'debug'] }] } }) };
  const intent = Schema.decodeUnknownSync(IntentSchema)({ kind: 'excludeSkill', profile: 'personal', source: 'https://github.com/Obra/Superpowers.git/', name: 'tdd' });
  const result = replay(before, [intent]);
  assert.deepEqual(result, { documents: { 'profiles/personal.json': json({ skills: { add: [{ source: 'obra/superpowers', names: ['debug'] }], remove: [{ source: 'obra/superpowers', names: ['tdd'] }] } }) }, invalid: [] });
});

test('including then excluding a skill leaves no empty add/remove list', () => {
  const before = { ...shared, 'integrations.json': json({ version: 1, integrations: [{ id: 'context7', label: 'Context7', type: 'mcp', target: 'codex', command: 'context7', default: false }] }) };
  const result = replay(before, [
    { kind: 'includeSkill', profile: 'personal', source: 'obra/superpowers', name: 'tdd' },
    { kind: 'excludeSkill', profile: 'personal', source: 'obra/superpowers', name: 'tdd' },
    { kind: 'setIntegration', profile: 'personal', id: 'context7', include: true },
    { kind: 'setIntegration', profile: 'personal', id: 'context7', include: false },
  ]);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(JSON.parse(result.documents['profiles/personal.json']!), { extends: 'base',
    skills: { remove: [{ source: 'obra/superpowers', names: ['tdd'] }] }, integrations: { remove: ['context7'] } });
  const back = replay(result.documents as Record<string, string>, [{ kind: 'includeSkill', profile: 'personal', source: 'obra/superpowers', name: 'tdd' }]);
  assert.deepEqual(JSON.parse(back.documents['profiles/personal.json']!).skills, { add: [{ source: 'obra/superpowers', names: ['tdd'] }] });
});

test('an intent for a missing profile is invalid with its index and reason', () => {
  const result = replay(shared, [
    { kind: 'pin', source: 'obra/superpowers', commit: 'a'.repeat(40) },
    { kind: 'includeSkill', profile: 'missing', source: 'obra/superpowers', name: 'tdd' },
    { kind: 'excludeSkill', profile: 'team', source: 'obra/superpowers', name: 'debug' },
  ]);
  assert.equal(result.invalid.length, 1);
  assert.equal(result.invalid[0]?.index, 1);
  assert.match(result.invalid[0]!.reason, /missing.*profile|profile.*missing/i);
  assert.equal(result.documents['profiles/missing.json'], undefined);
  assert.match(result.documents['profiles/team.json']!, /debug/);
});

test('capturing with own copy writes the new file and points only that profile at it', () => {
  const result = replay(shared, [{ kind: 'captureFile', profile: 'personal', fileId: 'claude:CLAUDE.md', text: 'Frozen text\n', choice: { kind: 'ownCopy', repoPath: 'claude/CLAUDE.personal.md' } }]);
  assert.deepEqual(result.invalid, []);
  assert.equal(result.documents['claude/CLAUDE.personal.md'], 'Frozen text\n');
  assert.equal(result.documents['claude/CLAUDE.md'], 'Shared rules\n');
  const documents = result.documents as Record<string, string>;
  for (const name of ['base', 'personal', 'team']) {
    const file = resolveNamedProfile({ documents, name }).files.find(file => file.id === 'claude:CLAUDE.md');
    assert.equal(file?.src, name === 'personal' ? 'claude/CLAUDE.personal.md' : 'claude/CLAUDE.md');
  }
});

test('capturing into a shared file lists every profile that uses it', () => {
  const documents = { ...shared, 'profiles/broken.json': json({ extends: 'missing' }), 'profiles/disabled.json': json({ files: { 'claude:CLAUDE.md': null } }) };
  assert.deepEqual(captureTargets(documents, 'personal', 'claude:CLAUDE.md'), { path: 'claude/CLAUDE.md', profiles: ['base', 'broken', 'personal', 'team'] });
  const result = replay(documents, [{ kind: 'captureFile', profile: 'personal', fileId: 'claude:CLAUDE.md', text: 'Updated\n', choice: { kind: 'updateShared' } }]);
  assert.deepEqual(result, { documents: { ...documents, 'claude/CLAUDE.md': 'Updated\n' }, invalid: [] });
});

test('pin and unpin edit skill-pins.json only', () => {
  const before = { ...shared, 'skill-pins.json': json({ version: 1, pins: { 'other/repo': 'b'.repeat(40) } }) };
  const pinned = replay(before, [{ kind: 'pin', source: 'obra/superpowers', commit: 'a'.repeat(40) }]);
  assert.deepEqual(pinned.invalid, []);
  assert.deepEqual(pinned.documents, { ...before, 'skill-pins.json': json({ version: 1, pins: { 'other/repo': 'b'.repeat(40), 'obra/superpowers': 'a'.repeat(40) } }) });
  assert.deepEqual(replay(pinned.documents as Record<string, string>, [{ kind: 'unpin', source: 'obra/superpowers' }]), { documents: before, invalid: [] });
});

test('capture schema caps UTF-8 bytes and rejects paths outside the two config directories', () => {
  const decode = Schema.decodeUnknownSync(IntentSchema);
  const intent = { kind: 'captureFile', profile: 'personal', fileId: 'claude:CLAUDE.md', text: 'a'.repeat(CAPTURE_MAX_BYTES), choice: { kind: 'ownCopy', repoPath: 'claude/personal.md' } };
  assert.doesNotThrow(() => decode(intent));
  assert.throws(() => decode({ ...intent, text: 'é'.repeat(CAPTURE_MAX_BYTES / 2 + 1) }));
  for (const repoPath of ['/claude/a', 'claude/../a', 'codex/../../a', 'elsewhere/a', 'claude\\a', 'claude/', 'claude/./a']) {
    assert.throws(() => decode({ ...intent, choice: { kind: 'ownCopy', repoPath } }), repoPath);
  }
});

for (const repoPath of ['claude/a\nb', 'claude/a\u0001b', 'codex/a\u007fb', 'claude/a\u0085b', 'claude/a ', 'codex/a\u00a0']) {
  test(`capture schema rejects control characters and trailing whitespace in ${JSON.stringify(repoPath)}`, () => {
    assert.throws(() => Schema.decodeUnknownSync(IntentSchema)({ kind: 'captureFile', profile: 'personal', fileId: 'claude:CLAUDE.md', text: 'frozen', choice: { kind: 'ownCopy', repoPath } }));
  });
}

test('profile edits replay in order and preserve inherited skill choices without duplicates', () => {
  const before = { ...shared, 'profiles/base.json': json({ skills: { add: [{ source: 'obra/superpowers', names: ['tdd'] }] } }) };
  const result = replay(before, [
    { kind: 'excludeSkill', profile: 'personal', source: 'obra/superpowers', name: 'tdd' },
    { kind: 'includeSkill', profile: 'personal', source: 'obra/superpowers', name: 'debug' },
    { kind: 'includeSkill', profile: 'personal', source: 'obra/superpowers', name: 'debug' },
    { kind: 'setFile', profile: 'personal', fileId: 'codex:config.toml', path: null },
    { kind: 'setFile', profile: 'team', fileId: 'claude:CLAUDE.md', path: 'claude/team.md' },
  ]);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(JSON.parse(result.documents['profiles/personal.json']!), { extends: 'base', skills: { remove: [{ source: 'obra/superpowers', names: ['tdd'] }], add: [{ source: 'obra/superpowers', names: ['debug'] }] }, files: { 'codex:config.toml': null } });
  assert.equal(result.documents['profiles/base.json'], before['profiles/base.json']);
  const config = resolveNamedProfile({ documents: result.documents as Record<string, string>, name: 'personal' });
  assert.equal(config.skills.find(skill => skill.name === 'tdd')?.install, false);
  assert.equal(config.files.find(file => file.id === 'codex:config.toml')?.managed, false);
});

test('integration edits cancel the opposite selection and reject undeclared integrations', () => {
  const before = { ...shared, 'integrations.json': json({ version: 1, integrations: [{ id: 'context7', label: 'Context7', type: 'mcp', target: 'codex', command: 'context7', default: false }] }) };
  const result = replay(before, [
    { kind: 'setIntegration', profile: 'personal', id: 'context7', include: false },
    { kind: 'setIntegration', profile: 'personal', id: 'context7', include: true },
    { kind: 'setIntegration', profile: 'personal', id: 'context7', include: true },
    { kind: 'setIntegration', profile: 'personal', id: 'unknown', include: true },
  ]);
  assert.equal(result.invalid.length, 1);
  assert.equal(result.invalid[0]?.index, 3);
  assert.match(result.invalid[0]!.reason, /not declared/);
  assert.deepEqual(JSON.parse(result.documents['profiles/personal.json']!), { extends: 'base', integrations: { add: ['context7'] } });
  assert.equal(result.documents['integrations.json'], before['integrations.json']);
});

test('ignore and unignore edit only source-ignores.json and preserve unrelated decisions', () => {
  const before = { ...shared, 'source-ignores.json': json({ version: 1, note: 'keep', ignored: { 'other/repo': 'b'.repeat(40) } }) };
  const ignored = replay(before, [{ kind: 'ignore', source: 'obra/superpowers', revision: 'a'.repeat(40) }]);
  assert.deepEqual(ignored, { documents: { ...before, 'source-ignores.json': json({ version: 1, note: 'keep', ignored: { 'other/repo': 'b'.repeat(40), 'obra/superpowers': 'a'.repeat(40) } }) }, invalid: [] });
  assert.deepEqual(replay(ignored.documents as Record<string, string>, [{ kind: 'unignore', source: 'obra/superpowers', revision: 'a'.repeat(40) }]), { documents: before, invalid: [] });
  assert.deepEqual(replay(shared, [{ kind: 'unpin', source: 'obra/superpowers' }, { kind: 'unignore', source: 'obra/superpowers', revision: 'a'.repeat(40) }]), { documents: shared, invalid: [] });
});

test('invalid creation and capture leave the document snapshot intact', () => {
  const before = { ...shared, 'profiles/disabled.json': json({ files: { 'claude:CLAUDE.md': null } }) };
  const result = replay(before, [
    { kind: 'createProfile', profile: 'new', extends: 'missing' },
    { kind: 'createProfile', profile: 'base', extends: null },
    { kind: 'captureFile', profile: 'disabled', fileId: 'claude:CLAUDE.md', text: 'Do not write', choice: { kind: 'updateShared' } },
    { kind: 'captureFile', profile: 'personal', fileId: 'claude:CLAUDE.md', text: 'Do not write', choice: { kind: 'ownCopy', repoPath: 'claude/CLAUDE.md' } },
  ]);
  assert.deepEqual(result.documents, before);
  assert.deepEqual(result.invalid.map(invalid => invalid.index), [0, 1, 2, 3]);
  assert.ok(result.invalid.every(invalid => invalid.reason.length > 0));
  assert.deepEqual(replay({}, [{ kind: 'createProfile', profile: 'new', extends: 'missing' }]).documents, {});
});

test('edits to the implicit default materialize its profile without changing root declarations', () => {
  const before = { 'claude/CLAUDE.md': 'Original\n' };
  const result = replay(before, [{ kind: 'includeSkill', profile: 'default', source: 'obra/superpowers', name: 'tdd' }]);
  assert.deepEqual(result, { documents: { ...before, 'profiles/default.json': json({ skills: { add: [{ source: 'obra/superpowers', names: ['tdd'] }] } }) }, invalid: [] });
});

test('malformed profile and pin documents are refused with a reason and remain untouched', () => {
  const before = { ...shared, 'profiles/personal.json': '{broken', 'skill-pins.json': '{"version":2}' };
  const result = replay(before, [
    { kind: 'includeSkill', profile: 'personal', source: 'obra/superpowers', name: 'tdd' },
    { kind: 'pin', source: 'obra/superpowers', commit: 'a'.repeat(40) },
  ]);
  assert.deepEqual(result.documents, before);
  assert.deepEqual(result.invalid.map(invalid => invalid.index), [0, 1]);
  assert.ok(result.invalid.every(invalid => invalid.reason.length > 0));
});

test('an integration intent for a missing profile reports the profile before its declarations', () => {
  const result = replay({}, [{ kind: 'setIntegration', profile: 'missing', id: 'context7', include: true }]);
  assert.deepEqual(result.documents, {});
  assert.equal(result.invalid[0]?.index, 0);
  assert.match(result.invalid[0]!.reason, /missing profile/i);
});

test('source policy intents preserve existing source identities outside GitHub', () => {
  const intent = Schema.decodeUnknownSync(IntentSchema)({ kind: 'pin', source: 'https://git.example.com/team/skills.git', commit: 'c'.repeat(40) });
  assert.deepEqual(replay({}, [intent]), {
    documents: { 'skill-pins.json': json({ version: 1, pins: { 'https://git.example.com/team/skills.git': 'c'.repeat(40) } }) }, invalid: [],
  });
});


test('capturing settings publishes only owned keys', () => {
  const documents = { ...shared, 'claude/settings.keys.json': json({ model: 'old', alwaysThinkingEnabled: false }) };
  const text = json({ model: 'new', permissions: { allow: ['Bash(*)'] }, enabledPlugins: { private: true }, env: { TOKEN: 'secret' }, hooks: { Stop: '/Users/private/hook' } });
  for (const choice of [{ kind: 'updateShared' as const }, { kind: 'ownCopy' as const, repoPath: 'claude/personal-settings.json' }]) {
    const result = replay(documents, [{ kind: 'captureFile', profile: 'personal', fileId: 'claude:settings.json', text, choice }]);
    assert.deepEqual(result.invalid, []);
    assert.deepEqual(JSON.parse(result.documents[choice.kind === 'updateShared' ? 'claude/settings.keys.json' : choice.repoPath]!), { model: 'new', alwaysThinkingEnabled: false });
    assert.equal(result.documents['claude/CLAUDE.md'], shared['claude/CLAUDE.md']);
  }
});

test('settings capture refuses invalid local JSON and secrets inside an owned key', () => {
  const documents = { ...shared, 'claude/settings.keys.json': json({ model: 'old' }) };
  for (const text of ['{', '[]', json({ model: { apiKey: 'secret' } })]) {
    const result = replay(documents, [{ kind: 'captureFile', profile: 'personal', fileId: 'claude:settings.json', text, choice: { kind: 'updateShared' } }]);
    assert.equal(result.invalid.length, 1);
    assert.deepEqual(result.documents, documents);
  }
});
