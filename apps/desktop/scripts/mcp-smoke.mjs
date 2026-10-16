import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { verifyAppRuntime } from './verify-runtime.mjs';
import { decodeOperationOutput } from '@nortuscc/agent/operations';

const app = realpathSync(resolve(process.argv[2] ?? ''));
assert.ok(process.argv.length === 3 && app.endsWith('.app'), 'Supply the finished installed-layout .app');
const executable = join(app, 'Contents/MacOS/nortuscc-desktop-validation');
const resources = join(app, 'Contents/Resources/agent-runtime');
const metadata = JSON.parse(readFileSync(join(resources, 'runtime.json'), 'utf8'));
await verifyAppRuntime(app, metadata.appVersion);
const home = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'mc-')));
const repo = join(home, 'repo'), state = join(home, 's'), agentDir = join(state, 'agent');
const tools = join(home, 'tools');
const env = { HOME: home, NORTUSCC_STATE_DIR: state, NORTUSCC_DESKTOP_LOCAL_ONLY: '1', PATH: tools, SHELL: join(home, 'shell'), TMPDIR: realpathSync(tmpdir()), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: repo, env, encoding: 'utf8', timeout: 10_000 }).trim();
const children = [], clients = [];
let abort = false;
const until = async get => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (abort) throw new Error('MCP smoke interrupted');
    const value = await get(); if (value !== undefined && value !== false) return value;
    await new Promise(done => setTimeout(done, 10));
  }
  throw new Error('MCP smoke timed out');
};
function owned(command, args, stdio) {
  const child = spawn(command, args, { cwd: '/', env, detached: true, stdio });
  const record = { child, exited: new Promise(done => child.once('close', (...result) => done(result))) };
  child.once('error', error => { record.error = error; });
  children.push(record);
  if (process.env.NORTUSCC_MCP_SMOKE_RECORD) writeFileSync(process.env.NORTUSCC_MCP_SMOKE_RECORD, JSON.stringify({ home, pids: children.map(item => item.child.pid).filter(Boolean) }));
  return record;
}
async function stop(record) {
  if (!record) return;
  const { child } = record;
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    try { await record.exited; } finally { clearTimeout(timer); }
  } else await record.exited;
}
function open() {
  const record = owned(executable, ['--mcp'], ['pipe', 'pipe', 'pipe']);
  const { child } = record;
  let stdout = '', stderr = '', buffer = '', next = 0, invalid;
  const replies = new Map();
  child.stdout.on('data', chunk => {
    stdout += chunk; buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const response = JSON.parse(line); assert.equal(response.jsonrpc, '2.0'); replies.set(response.id, response); }
      catch (error) { invalid = error; }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ask = async (method, params = {}) => {
    const id = ++next;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) + '\n');
    const reply = await until(() => {
      if (invalid) throw invalid; if (record.error) throw record.error;
      const result = replies.get(id); if (result) return result;
      assert.equal(child.exitCode, null, stderr);
      assert.equal(child.signalCode, null, stderr);
    });
    assert.equal(reply.error, undefined, JSON.stringify(reply)); return reply.result;
  };
  const call = async (operation, name, args) => {
    const result = await ask('tools/call', { name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    return decodeOperationOutput(operation, result.structuredContent);
  };
  const client = { ...record, ask, call, stdout: () => stdout, stderr: () => stderr };
  clients.push(client); return client;
}
async function eof(client) {
  client.child.stdin.end(); await client.exited;
  assert.equal(client.child.exitCode, 0, client.stderr());
}
process.once('SIGTERM', () => { abort = true; });
process.once('SIGINT', () => { abort = true; });
try {
  mkdirSync(repo); mkdirSync(agentDir, { recursive: true });
  write(join(repo, 'claude/CLAUDE.md'), '# MCP inert fixture\n');
  write(join(repo, 'codex/AGENTS.md'), '# MCP inert fixture\n');
  write(join(repo, 'claude/settings.keys.json'), JSON.stringify({ theme: 'dark' }));
  write(join(repo, 'integrations.json'), JSON.stringify({ version: 1, integrations: [] }));
  write(join(repo, 'skills-manifest.txt'), '');
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'MCP fixture'); git('config', 'user.email', 'mcp@example.invalid');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null'); git('add', '.'); git('commit', '-qm', 'Inert MCP fixture');
  const origin = join(home, 'origin.git'); git('init', '-q', '--bare', '-b', 'main', origin); git('remote', 'add', 'origin', origin); git('push', '-qu', 'origin', 'main');
  write(join(state, 'state.json'), JSON.stringify({ version: 1, repo, files: {} }));
  write(join(agentDir, 'agent.json'), JSON.stringify({ version: 1, installedBy: 'app', appPath: executable, agentVersion: metadata.agentVersion, policy: 'manual', policySource: 'person', paused: null }));
  write(join(agentDir, 'setups.json'), JSON.stringify({ version: 1, setups: [{ setupId: null, repoUrl: origin.replace(/\.git$/, ''), checkout: repo, trustedAt: new Date().toISOString() }] }));
  mkdirSync(tools);
  write(join(tools, 'git'), '#!/bin/sh\nexec /usr/bin/git "$@"\n'); chmodSync(join(tools, 'git'), 0o755);
  write(env.SHELL, '#!/bin/sh\nexec /bin/sh -c "$2"\n'); chmodSync(env.SHELL, 0o755);
  const agent = owned(join(resources, 'bun'), [join(resources, 'agent.mjs')], ['ignore', 'pipe', 'pipe']);
  let agentOutput = ''; agent.child.stdout.on('data', chunk => { agentOutput += chunk; }); agent.child.stderr.resume();
  await until(() => { if (agent.error) throw agent.error; assert.equal(agent.child.exitCode, null); return existsSync(join(agentDir, 'agent.sock')) && existsSync(join(agentDir, 'agent.token')); });
  let client = open();
  const toolsReply = await client.ask('tools/list');
  assert.deepEqual(toolsReply.tools.map(tool => tool.name).sort(), ['nortuscc_list_backups', 'nortuscc_agent_status', 'nortuscc_account_state', 'nortuscc_watch_sources', 'nortuscc_inspect_source_diff', 'nortuscc_pin_impact', 'nortuscc_draft_changelog', 'nortuscc_inspect_setups', 'nortuscc_incoming_changes', 'nortuscc_prepare_trust_request', 'nortuscc_inspect_updates', 'nortuscc_resolve_skill_candidate', 'nortuscc_inspect_intent', 'nortuscc_get_context', 'nortuscc_inspect', 'nortuscc_preview_change', 'nortuscc_apply_change', 'nortuscc_get_run', 'nortuscc_list_runs', 'nortuscc_cancel_run', 'nortuscc_abandon_run', 'nortuscc_history'].sort());
  const context = await client.call('getContext', 'nortuscc_get_context', {});
  assert.equal(context.app.ownership, 'app'); assert.equal(context.capabilities.addSkill.available, true);
  const inspected = await client.call('inspect', 'nortuscc_inspect', {});
  assert.ok(inspected.items.length > 0); assert.deepEqual(inspected.profile.issues, []); assert.deepEqual(inspected.probeErrors, []);
  const agentStatus=await client.call('agentStatus','nortuscc_agent_status',{section:'status',limit:1}); assert.equal(agentStatus.section,'status');
  const backups=await client.call('listBackups','nortuscc_list_backups',{limit:1}); assert.ok(Array.isArray(backups.folders));
  const accountState=await client.call('accountState','nortuscc_account_state',{section:'account',limit:1}); assert.equal(accountState.section,'account');
  const knownSetups=await client.call('inspectSetups','nortuscc_inspect_setups',{limit:5}); assert.equal(knownSetups.items[0].setupId,'local'); assert.equal(knownSetups.items[0].trusted,true);
  const syncOffers=await client.call('incomingChanges','nortuscc_incoming_changes',{setupId:'local',limit:5}); assert.equal(syncOffers.revision.kind,'local'); assert.deepEqual(syncOffers.items,[]);
  const trustRequest=await client.call('prepareTrustRequest','nortuscc_prepare_trust_request',{setupId:'local'}); assert.equal(trustRequest.action,'open-app-repository-trust');
  const watchedSources=await client.call('watchSources','nortuscc_watch_sources',{}); assert.deepEqual(watchedSources.items,[]);
  const changelog=await client.call('draftChangelog','nortuscc_draft_changelog',{accepted:[]}); assert.equal(changelog.text,'');
  for (const [name,args] of [['nortuscc_pin_impact',{sourceId:'unknown/repo',revision:'HEAD'}],['nortuscc_inspect_source_diff',{sourceId:'unknown/repo',fromRevision:'a'.repeat(40),toRevision:'b'.repeat(40),skillId:'skill:unknown/repo/missing'}]]) { const refused=await client.ask('tools/call',{name,arguments:args}); assert.equal(refused.isError,true); }
  const updateOffers = await client.call('inspectUpdates', 'nortuscc_inspect_updates', { limit: 5 });
  assert.deepEqual(updateOffers.items, []); assert.equal(updateOffers.unavailable, false);
  const preview = await client.call('previewChange', 'nortuscc_preview_change', { change: { kind: 'reconcile', only: inspected.items.filter(item => item.key === 'config:claude:CLAUDE.md').map(item => item.key) } });
  assert.ok(preview.plan.steps.length > 0); assert.ok(preview.plan.steps.every(step => step.domain === 'config'));
  const started = await client.call('applyChange', 'nortuscc_apply_change', { planId: preview.planId, requestId: 'packaged-smoke-apply' });
  assert.equal(started.status, 'started');
  await eof(client); assert.equal(agent.child.exitCode, null, 'MCP EOF stopped the agent');
  client = open();
  const resumed = await client.call('getRun', 'nortuscc_get_run', { runId: started.run.runId });
  assert.ok(['accepted', 'running', 'succeeded'].includes(resumed.state));
  const completed = await until(async () => { const run = await client.call('getRun', 'nortuscc_get_run', { runId: started.run.runId }); return run.state === 'succeeded' && run; });
  assert.equal(completed.result.status, 'done'); assert.equal(completed.result.failed, 0); assert.equal(completed.intentSaved, false);
  assert.equal(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8'), '# MCP inert fixture\n');
  console.log('MCP inspection and inert reconciliation passed');
  const retried = await client.call('applyChange', 'nortuscc_apply_change', { planId: preview.planId, requestId: 'packaged-smoke-apply' });
  assert.equal(retried.run.runId, started.run.runId);
  const runs = await client.call('listRuns', 'nortuscc_list_runs', { limit: 20 }); assert.equal(runs.runs.filter(run => run.runId === started.run.runId).length, 1);
  const history = await client.call('history', 'nortuscc_history', { limit: 100 });
  const events = history.events.filter(event => event.runId === started.run.runId && event.operation === 'applyChange');
  assert.ok(events.length >= 2); for (const event of events) { assert.equal(event.actor, 'mcp'); assert.equal(event.requestId, 'packaged-smoke-apply'); assert.deepEqual(event.scope, { kind: 'machine' }); }
  console.log('MCP disconnect recovery and attributed History passed');
  // A completed run remains authorized and cancellation returns its settled receipt unchanged.
  const cancelled = await client.call('cancelRun', 'nortuscc_cancel_run', { runId: started.run.runId });
  assert.deepEqual(cancelled, completed); assert.equal(existsSync(join(state, 'apply.lock')), false);
  const token = readFileSync(join(agentDir, 'agent.token'), 'utf8').trim();
  await eof(client); assert.equal(agent.child.exitCode, null);
  await stop(agent); assert.equal(agent.child.exitCode, 0); assert.equal(agentOutput, '');
  client = open();
  const unavailable = await client.ask('tools/call', { name: 'nortuscc_inspect', arguments: {} });
  assert.equal(unavailable.isError, true); assert.equal(unavailable.structuredContent.error.code, 'APP_UNAVAILABLE');
  assert.match(unavailable.structuredContent.error.message, /Nortuscc/); await eof(client);
  for (const checked of clients) {
    for (const line of checked.stdout().trim().split('\n').filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, '2.0');
    for (const secret of [token, executable, readFileSync(join(agentDir, 'agent.json'), 'utf8')]) assert.ok(!checked.stdout().includes(secret));
  }
  assert.equal(existsSync(join(home, 'Library/LaunchAgents')), false); assert.equal(existsSync(join(agentDir, 'agent.sock')), false);
  console.log('MCP terminal cancellation lookup and local-agent failure passed');
  console.log('Installed app MCP smoke passed on temporary HOME');
} finally {
  for (const record of children.reverse()) await stop(record);
  rmSync(home, { recursive: true, force: true });
}
