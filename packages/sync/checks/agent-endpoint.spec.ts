import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_PIPE_FILE, AgentEndpointError, agentEndpoint, newPipeName } from '../src/index.ts';

const PIPE = /^\\\\\.\\pipe\\nortuscc-agent-[0-9a-f]{32}$/;

const withDir = (body: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'endpoint-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('off Windows the endpoint is agent.sock, without reading agent.pipe', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    assert.equal(agentEndpoint(join('state', 'agent'), platform), join('state', 'agent', 'agent.sock'));
  }
});

test('newPipeName draws a fresh per-start pipe name', () => {
  const a = newPipeName();
  const b = newPipeName();
  assert.match(a, PIPE);
  assert.match(b, PIPE);
  assert.notEqual(a, b);
});

test('on Windows the endpoint is the trimmed pipe name in agent.pipe', () => {
  withDir((dir) => {
    const name = newPipeName();
    writeFileSync(join(dir, AGENT_PIPE_FILE), `${name}\n`);
    assert.equal(AGENT_PIPE_FILE, 'agent.pipe');
    assert.equal(agentEndpoint(dir, 'win32'), name);
  });
});

test('on Windows a missing agent.pipe is an AgentEndpointError', () => {
  withDir((dir) => {
    assert.throws(() => agentEndpoint(dir, 'win32'), (error) => error instanceof AgentEndpointError && /agent\.pipe/.test(error.message));
  });
});

for (const content of ['', 'nortuscc-agent-0123', '\\\\.\\pipe\\other-0123456789abcdef0123456789abcdef',
  '\\\\.\\pipe\\nortuscc-agent-0123456789ABCDEF0123456789ABCDEF', '\\\\.\\pipe\\nortuscc-agent-0123456789abcdef0123456789abcdef0',
  '\\\\server\\pipe\\nortuscc-agent-0123456789abcdef0123456789abcdef']) {
  test(`on Windows agent.pipe holding ${JSON.stringify(content)} is refused`, () => {
    withDir((dir) => {
      writeFileSync(join(dir, AGENT_PIPE_FILE), content);
      assert.throws(() => agentEndpoint(dir, 'win32'), AgentEndpointError);
    });
  });
}
