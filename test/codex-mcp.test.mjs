import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mcpCommand, installMcp, describeMcp, inspectMcp } from '../src/integrations/codex-mcp.mjs';

const PLAIN = {
  id: 'files', label: 'files', target: 'codex', type: 'mcp', default: true,
  command: 'mcp-files', args: ['--root', '/srv'],
};

const NEEDS_KEY = {
  id: 'openai', label: 'openai', target: 'codex', type: 'mcp', default: false,
  command: 'openai-mcp', requiresEnv: ['OPENAI_API_KEY'],
};

function record(calls) {
  return async (command) => {
    calls.push(command);
    return { ok: true };
  };
}

// The supported command interface, not a hand-edited config.toml: Codex owns
// that file's format, and rewriting it behind Codex's back is exactly the kind
// of layout ownership the design gives back to the native tool.
test('the MCP declaration becomes a codex mcp add argv array', () => {
  assert.deepEqual(mcpCommand(PLAIN), {
    cmd: 'codex',
    args: ['mcp', 'add', 'files', '--', 'mcp-files', '--root', '/srv'],
  });
});

test('MCP adapter blocks before spawning when required env is absent', async () => {
  const calls = [];
  const result = await installMcp(NEEDS_KEY, { env: {}, spawn: record(calls) });
  assert.equal(result.ok, false);
  assert.match(result.note, /OPENAI_API_KEY/);
  assert.deepEqual(calls, []);
});

test('a satisfied env requirement lets the install proceed', async () => {
  const calls = [];
  const result = await installMcp(NEEDS_KEY, {
    env: { OPENAI_API_KEY: 'sk-not-a-real-key' },
    spawn: record(calls),
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'codex');
});

// The value of a required variable must never reach a printed command, a log
// line, or a result note — only the variable's name may be shown.
test('describe and results name the variable but never its value', () => {
  const description = describeMcp(NEEDS_KEY, { env: { OPENAI_API_KEY: 'sk-super-secret-value' } });
  assert.match(description, /OPENAI_API_KEY/);
  assert.doesNotMatch(description, /sk-super-secret-value/);
});

test('a blocked item reports its prerequisite guidance without the value', async () => {
  const result = await installMcp(NEEDS_KEY, {
    env: { SOMETHING_ELSE: 'sk-super-secret-value' },
    spawn: record([]),
  });
  assert.doesNotMatch(result.note, /sk-super-secret-value/);
  assert.match(result.note, /OPENAI_API_KEY/);
});

test('inspection reports blocked, not missing, when a prerequisite is absent', () => {
  assert.equal(inspectMcp(NEEDS_KEY, { env: {}, installed: [] }).state, 'blocked');
  assert.equal(inspectMcp(NEEDS_KEY, { env: { OPENAI_API_KEY: 'x' }, installed: [] }).state, 'missing');
  assert.equal(inspectMcp(PLAIN, { env: {}, installed: ['files'] }).state, 'installed');
});

// Several missing variables are all worth naming at once: fixing one at a time
// across repeated runs is the slow way to discover the rest.
test('every missing variable is named, not just the first', async () => {
  const item = { ...NEEDS_KEY, requiresEnv: ['ONE_KEY', 'TWO_KEY'] };
  const result = await installMcp(item, { env: {}, spawn: record([]) });
  assert.match(result.note, /ONE_KEY/);
  assert.match(result.note, /TWO_KEY/);
});

test('an empty-string variable counts as absent, not as satisfied', async () => {
  const calls = [];
  const result = await installMcp(NEEDS_KEY, { env: { OPENAI_API_KEY: '' }, spawn: record(calls) });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
});

test('a launch failure is reported rather than thrown', async () => {
  const result = await installMcp(PLAIN, {
    env: {},
    spawn: async () => ({ ok: false, note: 'could not launch `codex`: ENOENT' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.note, /codex/);
});
