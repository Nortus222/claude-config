import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMcp, inspectMcp, mcpCommand, missingEnv } from '../src/integrations/mcp.ts';
import type { Declaration } from '../src/integrations/declaration.ts';

const PLAIN: Declaration = { id: 'files', label: 'files', target: 'codex', type: 'mcp', default: true, command: 'mcp-files', args: ['--root', '/srv'] };
const NEEDS_KEY: Declaration = { id: 'openai', label: 'openai', target: 'codex', type: 'mcp', default: false, command: 'openai-mcp', requiresEnv: ['OPENAI_API_KEY'] };

// `--` keeps a server flag from being read as a flag to `codex mcp add`.
test('an MCP declaration becomes a codex mcp add argv array', () => {
  assert.deepEqual(mcpCommand(PLAIN), { cmd: 'codex', args: ['mcp', 'add', 'files', '--', 'mcp-files', '--root', '/srv'] });
});

test('inspection reports blocked, not missing, when a prerequisite is absent', () => {
  assert.equal(inspectMcp(NEEDS_KEY, {}).state, 'blocked');
  assert.equal(inspectMcp(NEEDS_KEY, { OPENAI_API_KEY: 'x' }).state, 'missing');
  assert.equal(inspectMcp(PLAIN, {}, ['files']).state, 'installed');
});

test('a blocked note names every missing variable and the guidance, never a value', () => {
  const item = { ...NEEDS_KEY, requiresEnv: ['ONE_KEY', 'TWO_KEY'], prerequisite: 'See the runbook.' };
  const note = inspectMcp(item, { SOMETHING_ELSE: 'sk-super-secret-value' }).note;
  assert.match(note, /ONE_KEY/);
  assert.match(note, /TWO_KEY/);
  assert.match(note, /See the runbook\./);
  assert.doesNotMatch(note, /sk-super-secret-value/);
});

test('an empty-string variable counts as absent', () => {
  assert.deepEqual(missingEnv(NEEDS_KEY, { OPENAI_API_KEY: '' }), ['OPENAI_API_KEY']);
});

test('describe names the variable but never its value', () => {
  const description = describeMcp(NEEDS_KEY, { OPENAI_API_KEY: 'sk-super-secret-value' });
  assert.equal(description, 'codex mcp add openai -- openai-mcp  (reads OPENAI_API_KEY from the environment)');
  assert.match(describeMcp(NEEDS_KEY, {}), /\[blocked: OPENAI_API_KEY not set\]$/);
});
