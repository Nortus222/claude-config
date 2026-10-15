import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bindAuthorCheckout, prepareCapture, executeCapture, selectAll } from '../src/index.ts';
import { Effect } from 'effect';
import { authorMachine } from './author-machine.ts';
const observer = { pending: () => Effect.void, committed: () => Effect.void };
test('explicit config-only and empty capture preserve manifest and snapshot; multi-document capture succeeds', async () => {
 const m = authorMachine(); await m.sync();
 m.write(join(m.paths.claude, 'CLAUDE.md'), '# local\n'); m.write(join(m.paths.codex, 'AGENTS.md'), '# local codex\n');
 m.write(join(m.paths.repo, 'skills-manifest.txt'), '# preserved\n');
 const desired = await m.desired(); const author = await m.run(bindAuthorCheckout(m.paths, desired.files.map(f => f.src)));
 const input = { author, desired, heldItemIds: [], heldManifestGroups: [], selection: { ...selectAll, only: ['config:claude:CLAUDE.md', 'config:codex:AGENTS.md'] }, allowShrink: false, manageConfig: true };
 const empty = await m.run(prepareCapture({ ...input, selection: { ...selectAll, only: [] } })); assert.equal(empty.plan.steps.length, 0);
 const prepared = await m.run(prepareCapture(input)); assert.equal(prepared.manifest.write, false);
 await m.run(executeCapture(prepared, new AbortController().signal, observer));
 assert.equal(m.read(join(m.paths.repo, 'claude/CLAUDE.md')), '# local\n'); assert.equal(m.read(join(m.paths.repo, 'codex/AGENTS.md')), '# local codex\n');
 assert.equal(m.read(join(m.paths.repo, 'skills-manifest.txt')), '# preserved\n');
});

test('snapshot allowlist cannot restore an author-deleted key; selected JSON replacement retains unrelated bytes', async () => {
 const m = authorMachine(); await m.sync(); const desired = await m.desired();
 m.write(join(m.paths.repo, 'claude/settings.keys.json'), '{  "theme" : "dark"  }\r\n');
 m.write(join(m.paths.claude, 'settings.json'), '{"theme":"light","model":"local","undeclared":true}');
 const author = await m.run(bindAuthorCheckout(m.paths, ['claude/settings.keys.json']));
 const input = { author, desired, heldItemIds: [], heldManifestGroups: [], selection: { ...selectAll, only: ['config:claude:settings.json#theme'] }, allowShrink: false, manageConfig: true };
 await assert.rejects(m.run(prepareCapture({ ...input, selection: { ...selectAll, only: ['config:claude:settings.json#model'] } })));
 const prepared = await m.run(prepareCapture(input));
 await m.run(executeCapture(prepared, new AbortController().signal, observer));
 assert.equal(m.read(join(m.paths.repo, 'claude/settings.keys.json')), '{  "theme" : "light"  }\r\n');
});

test('capture preserves held declarations and refuses zero-skill regeneration even with shrink enabled', async () => {
 const m = authorMachine(); m.write(join(m.paths.repo, 'skills-manifest.txt'), '[owner/repo] exact\nheld\ngone\n');
 const author = await m.run(bindAuthorCheckout(m.paths, ['skills-manifest.txt']));
 const input = { author, desired: await m.desired(), heldItemIds: ['skill:owner/repo/held'], heldManifestGroups: [{ source: 'owner/repo', exact: true, optional: false, skills: ['held'] }], selection: { ...selectAll, only: ['skills:manifest'] }, allowShrink: false, manageConfig: false };
 const refused = await m.run(prepareCapture(input)); assert.equal(refused.manifest.write, false); assert.match(refused.manifest.reason, /would drop 1/);
 const held = await m.run(prepareCapture({ ...input, allowShrink: true })); assert.equal(held.manifest.write, true); assert.match(held.documents[0]!.text, /\[owner\/repo\] exact\nheld\n/);
 const empty = await m.run(prepareCapture({ ...input, allowShrink: true, heldItemIds: [], heldManifestGroups: [] })); assert.equal(empty.manifest.write, false); assert.equal(empty.documents.length, 0);
});

test('legacy state preview writes no state, overrides or backups', async () => {
 const m = authorMachine();
 m.write(join(m.paths.claude, '.nortuscc-lock.json'), JSON.stringify({ version: 1, repo: m.paths.repo, files: {}, skillsOnly: true }));
 m.write(join(m.paths.claude, 'CLAUDE.md'), '# local\n');
 const author = await m.run(bindAuthorCheckout(m.paths, ['claude/CLAUDE.md']));
 await m.run(prepareCapture({ author, desired: await m.desired(), heldItemIds: [], heldManifestGroups: [], selection: { ...selectAll, only: ['config:claude:CLAUDE.md'], force: true }, allowShrink: false, manageConfig: true }));
 assert.equal(m.read(join(m.paths.stateRoot, 'state.json')), undefined); assert.equal(m.read(join(m.paths.stateRoot, 'overrides.json')), undefined);
 const { existsSync } = await import('node:fs'); assert.equal(existsSync(m.paths.backups), false);
});

test('capture rejects changed machine bytes and external edits between documents', async () => {
 for (const external of ['claude/CLAUDE.md', 'codex/AGENTS.md']) {
  const m = authorMachine(); await m.sync();
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# first\n'); m.write(join(m.paths.codex, 'AGENTS.md'), '# second\n');
  const author = await m.run(bindAuthorCheckout(m.paths, ['claude/CLAUDE.md', 'codex/AGENTS.md']));
  const prepared = await m.run(prepareCapture({ author, desired: await m.desired(), heldItemIds: [], heldManifestGroups: [], selection: { ...selectAll, only: ['config:claude:CLAUDE.md', 'config:codex:AGENTS.md'] }, allowShrink: false, manageConfig: true }));
  const commits: string[] = [];
  await assert.rejects(m.run(executeCapture(prepared, new AbortController().signal, { pending: () => Effect.void, committed: key => Effect.sync(() => { commits.push(key); m.write(join(m.paths.repo, external), '# external\n'); }) })));
  assert.deepEqual(commits, ['config:claude:CLAUDE.md']);
  assert.equal(m.read(join(m.paths.repo, 'codex/AGENTS.md')), external === 'codex/AGENTS.md' ? '# external\n' : '# repo codex\n');
 }
 const m = authorMachine(); await m.sync(); m.write(join(m.paths.claude, 'CLAUDE.md'), '# preview\n');
 const author = await m.run(bindAuthorCheckout(m.paths, ['claude/CLAUDE.md']));
 const prepared = await m.run(prepareCapture({ author, desired: await m.desired(), heldItemIds: [], heldManifestGroups: [], selection: { ...selectAll, only: ['config:claude:CLAUDE.md'] }, allowShrink: false, manageConfig: true }));
 m.write(join(m.paths.claude, 'CLAUDE.md'), '# changed\n'); await assert.rejects(m.run(executeCapture(prepared, new AbortController().signal, observer)));
});

test('failed second document and failed baseline save retain the first exact backup and observed write', async () => {
 const { Fs, FsFailed, StateStore, Backups } = await import('../src/index.ts');
 for (const failure of ['second', 'baseline']) {
  const m = authorMachine(); await m.sync(); m.write(join(m.paths.claude, 'CLAUDE.md'), '# first\n'); m.write(join(m.paths.codex, 'AGENTS.md'), '# second\n');
  const author = await m.run(bindAuthorCheckout(m.paths, ['claude/CLAUDE.md', 'codex/AGENTS.md']));
  const prepared = await m.run(prepareCapture({ author, desired: await m.desired(), heldItemIds: [], heldManifestGroups: [], selection: { ...selectAll, only: failure === 'baseline' ? ['config:claude:CLAUDE.md'] : ['config:claude:CLAUDE.md', 'config:codex:AGENTS.md'] }, allowShrink: false, manageConfig: true }));
  const commits: string[] = []; let backup: string | undefined;
  await m.run(Effect.gen(function* () {
   const fs = yield* Fs; const store = yield* StateStore; const backups = yield* Backups;
   const fail = new FsFailed({ op: 'write', path: 'private', reason: 'private exception' });
   const operation = executeCapture(prepared, new AbortController().signal, { pending: () => Effect.void, committed: key => Effect.sync(() => { commits.push(key); }) }).pipe(
    Effect.provideService(Fs, { ...fs, writeTextAtomic: (path,text) => failure === 'second' && path.endsWith('codex/AGENTS.md') ? Effect.fail(fail) : fs.writeTextAtomic(path,text) }),
    Effect.provideService(StateStore, { ...store, update: f => failure === 'baseline' ? Effect.fail(fail) : store.update(f) }));
   const exit = yield* Effect.exit(operation); assert.equal(exit._tag, 'Failure'); backup = yield* backups.dir;
  }));
  assert.deepEqual(commits, ['config:claude:CLAUDE.md']); assert.equal(m.read(join(m.paths.repo, 'claude/CLAUDE.md')), '# first\n');
  assert.equal(m.read(join(backup!, 'claude/CLAUDE.md.repo')), '# repo claude\n');
 }
});

test('raw state edits invalidate capture even when parsed state is identical', async () => {
 const m = authorMachine(); await m.sync(); m.write(join(m.paths.claude, 'CLAUDE.md'), '# local\n');
 const author = await m.run(bindAuthorCheckout(m.paths, ['claude/CLAUDE.md']));
 const prepared = await m.run(prepareCapture({ author, desired: await m.desired(), heldItemIds: [], heldManifestGroups: [], selection: { ...selectAll, only: ['config:claude:CLAUDE.md'] }, allowShrink: false, manageConfig: true }));
 m.write(join(m.paths.stateRoot, 'state.json'), m.read(join(m.paths.stateRoot, 'state.json'))! + ' ');
 await assert.rejects(m.run(executeCapture(prepared, new AbortController().signal, observer)));
 assert.equal(m.read(join(m.paths.repo, 'claude/CLAUDE.md')), '# repo claude\n');
});

test('settings capture changes only the selected nested value and refuses duplicate selected keys', async () => {
 const { replaceOwnedJsonValue } = await import('../src/config/json-value.ts');
 const text = '{ "other": {"escaped":"a\\\"b", "list":[1,{"k":"v"}]}, "selected" : [1, 2], "last" : true }\r\n';
 assert.equal(replaceOwnedJsonValue(text, 'selected', { next: 'x' }), text.replace('[1, 2]', '{"next":"x"}'));
 assert.throws(() => replaceOwnedJsonValue('{"selected":1,"selected":2}', 'selected', 3), /duplicate/);
});

test('shared capture strips owned routing bytes and leaves held configuration untouched', async () => {
 const { inspectMcpRouting, setMcpRouting, MCP_ROUTING_BYTES } = await import('../src/index.ts');
 const m = authorMachine(); await m.sync(); const desired = await m.desired();
 const before = await m.run(inspectMcpRouting(desired, 'claude:CLAUDE.md'));
 await m.run(setMcpRouting(desired, 'claude:CLAUDE.md', true, before.evidence));
 m.write(join(m.paths.claude, 'CLAUDE.md'), '# captured\r\n' + MCP_ROUTING_BYTES);
 m.write(join(m.paths.codex, 'AGENTS.md'), '# held edit\n');
 const author = await m.run(bindAuthorCheckout(m.paths, ['claude/CLAUDE.md', 'codex/AGENTS.md']));
 const prepared = await m.run(prepareCapture({ author, desired, heldItemIds: ['file:codex:AGENTS.md'], heldManifestGroups: [], selection: { ...selectAll, only: ['config:claude:CLAUDE.md', 'config:codex:AGENTS.md'] }, allowShrink: false, manageConfig: true }));
 assert.ok(prepared.plan.skipped.some(item => item.key === 'config:codex:AGENTS.md' && item.reason === 'held by nortuscc sync'));
 await m.run(executeCapture(prepared, new AbortController().signal, observer));
 assert.equal(m.read(join(m.paths.repo, 'claude/CLAUDE.md')), '# captured\r\n'); assert.equal(m.read(join(m.paths.repo, 'codex/AGENTS.md')), '# repo codex\n');
 assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), '# captured\r\n' + MCP_ROUTING_BYTES);
});
