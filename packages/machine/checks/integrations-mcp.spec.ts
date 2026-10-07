import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { nodeProcesses } from '../src/index.ts';
import { codexMcpListCommand, describeMcp, inspectMcp, mcpCommand, missingEnv, readCodexMcp } from '../src/integrations/mcp.ts';
import { fakeBin } from './support/integrations.ts';
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

const mcpState = (path: string) => Effect.runPromise(readCodexMcp.pipe(Effect.provide(nodeProcesses({ path }))));

// Shape copied from codex-cli 0.160.1's `codex mcp list --json`, values replaced.
const SERVERS = [
  {
    name: 'node_repl', enabled: true, disabled_reason: null,
    transport: { type: 'stdio', command: '/bin/node', args: ['repl.js'], env: { NODE_REPL_TOKEN: 'sk-fixture-secret' }, env_vars: ['HOME', 'PATH'], cwd: '/tmp' },
    startup_timeout_sec: null, tool_timeout_sec: 120, auth_status: 'unsupported',
  },
  {
    name: 'code-review', enabled: false, disabled_reason: null,
    transport: { type: 'stdio', command: '/bin/review', args: [], env: null, env_vars: [], cwd: '/tmp' },
    startup_timeout_sec: null, tool_timeout_sec: 120, auth_status: 'unsupported',
  },
];

test('the MCP list command is codex mcp list --json', () => {
  assert.deepEqual(codexMcpListCommand(), { cmd: 'codex', args: ['mcp', 'list', '--json'] });
});

// A disabled server is still configured: re-adding it would overwrite the owner's choice.
test('configured servers, enabled or not, are read by name from codex mcp list --json', async () => {
  const fake = fakeBin();
  fake.codex({ installed: [] }, { marketplaces: [] }, 'process.exit(0)', [...SERVERS, { enabled: true }]);
  const state = await mcpState(fake.path);
  assert.deepEqual([...state.servers], ['node_repl', 'code-review']);
  assert.equal(state.error, undefined);
  assert.deepEqual(fake.calls(), ['codex mcp list --json']);
  assert.equal(inspectMcp({ ...PLAIN, id: 'code-review' }, {}, [...state.servers]).state, 'installed');
});

test('an empty list means nothing configured', async () => {
  const fake = fakeBin();
  fake.codex({ installed: [] }, { marketplaces: [] }, 'process.exit(0)', []);
  assert.deepEqual(await mcpState(fake.path), { servers: new Set() });
});

// Nothing configured plus a reason: never a failure of the inspect.
test('an absent codex, a non-zero exit or output of another shape is nothing configured with an error', async () => {
  const absent = await mcpState(fakeBin().path);
  assert.equal(absent.servers.size, 0);
  assert.match(absent.error ?? '', /could not list Codex MCP servers: could not launch codex/);
  const exits = fakeBin();
  exits.tool('codex', 'process.exit(3)');
  assert.match((await mcpState(exits.path)).error ?? '', /could not list Codex MCP servers: exited 3/);
  const garbage = fakeBin();
  garbage.tool('codex', 'console.log("not-json")');
  assert.match((await mcpState(garbage.path)).error ?? '', /could not read the Codex MCP server list/);
  const object = fakeBin();
  object.codex({ installed: [] }, { marketplaces: [] }, 'process.exit(0)', { servers: SERVERS });
  assert.match((await mcpState(object.path)).error ?? '', /could not read the Codex MCP server list/);
});
