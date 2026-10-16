import { makeHostedRuntime } from '../../../packages/agent/src/hosted.ts';
import type { HostedClient, HostedState } from '@nortuscc/hosted-client';
import { sourceEnvironment, sourceIdentity } from '../../../packages/agent/src/operations/sources.ts';
import { makeRepo, tempDir, commitFiles, gitSync } from '../../../packages/source-watch/checks/fixtures.ts';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { before, after, test } from 'node:test';
import { build } from 'esbuild';
import { Deferred, Effect, Exit, Scope, Layer } from 'effect';
import { AgentStateStore, makeSession, serveIpc, startAgent, SetupSource, type AgentDomain } from '@nortuscc/agent';
import { configDomain, DecisionsStore, integrationsDomain, Processes, skillsDomain, OverridesStore, Fs, FsFailed } from '@nortuscc/machine';
import { decodeOperationOutput, operationDefinitions, operationJsonSchemas, type OperationName } from '@nortuscc/agent/operations';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import { toolNames } from '../mcp/server.ts';
import { operation } from '../src/operations.ts';
import { agentSkillInstaller } from '../../../packages/agent/src/skill-installer.ts';
import { agentMachine } from '../../../packages/agent/checks/support/agent-machine.ts';
import { accept, EFFORT, setupFixture } from '../../../packages/agent/checks/support/setup-fixture.ts';

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-bundle-')));
const bundle = join(fixtureRoot, 'Test.app/Contents/Resources/agent-runtime');
const expectedApp = join(fixtureRoot, 'Test.app/Contents/MacOS/Test');
const nativeRuntime = process.env.DESKTOP_MCP_NATIVE_RUNTIME;
const packagedResources = process.env.DESKTOP_AGENT_RESOURCES;
const expectedRuntime = nativeRuntime && packagedResources ? JSON.parse(readFileSync(join(packagedResources, 'runtime.json'), 'utf8')).agentVersion : '9.9.9';
const shell = join(fixtureRoot, 'shell');
before(async () => {
  mkdirSync(bundle, { recursive: true }); mkdirSync(dirname(expectedApp), { recursive: true });
  writeFileSync(shell, '#!/bin/sh\nexec /bin/sh -c "$2"\n'); chmodSync(shell, 0o755);
  if (nativeRuntime && packagedResources) {
    cpSync(packagedResources, bundle, { recursive: true }); copyFileSync(nativeRuntime, expectedApp); chmodSync(expectedApp, 0o755);
  } else {
    await build({ entryPoints: [fileURLToPath(new URL('../mcp/main.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', target: 'esnext', outfile: join(bundle, 'mcp.mjs') });
    writeFileSync(join(bundle, 'runtime.json'), JSON.stringify({ target: 'darwin-arm64', appVersion: '0.1.6', agentVersion: expectedRuntime, mcp: { protocol: 1, executable: 'mcp.mjs' } }));
  }
});
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
const names: Record<OperationName, string> = {authorProfiles:'nortuscc_author_profiles',machineFile:'nortuscc_machine_file',authorFile:'nortuscc_author_file',upstreams:'nortuscc_upstreams',discoverUpstream:'nortuscc_discover_upstream',upstreamSkill:'nortuscc_upstream_skill',drafts:'nortuscc_drafts',draftPreview:'nortuscc_draft_preview',ghState:'nortuscc_gh_state',setupReview:'nortuscc_setup_review',listBackups:'nortuscc_list_backups',agentStatus:'nortuscc_agent_status',accountState:'nortuscc_account_state',watchSources: 'nortuscc_watch_sources', inspectSourceDiff: 'nortuscc_inspect_source_diff', pinImpact: 'nortuscc_pin_impact', draftChangelog: 'nortuscc_draft_changelog',  inspectSetups:'nortuscc_inspect_setups', incomingChanges:'nortuscc_incoming_changes', prepareTrustRequest:'nortuscc_prepare_trust_request', inspectUpdates: 'nortuscc_inspect_updates', inspectIntent: 'nortuscc_inspect_intent', resolveSkillCandidate: 'nortuscc_resolve_skill_candidate', getContext: 'nortuscc_get_context', inspect: 'nortuscc_inspect', previewChange: 'nortuscc_preview_change', applyChange: 'nortuscc_apply_change', getRun: 'nortuscc_get_run', listRuns: 'nortuscc_list_runs', cancelRun: 'nortuscc_cancel_run', abandonRun: 'nortuscc_abandon_run', history: 'nortuscc_history' };

// Real newline-delimited MCP over the packaged entry, with every stdout record captured.
function open(runtime: string, stateRoot: string, modern = false) {
  const child = spawn(runtime, runtime === expectedApp ? ['--mcp'] : [join(bundle, 'mcp.mjs'), '--app', expectedApp], { cwd: '/', env: { HOME: fixtureRoot, SHELL: shell, NORTUSCC_STATE_DIR: stateRoot, PATH: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const records: any[] = [];
  let buffer = '', stderr = '', id = 0, terminated = false, loseNext = false, lostReplyId: number | undefined, dropped = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const record = JSON.parse(line);
        if (record.id === lostReplyId) { dropped++; continue; }
        records.push(record);
        const p = pending.get(record.id); if (p) { clearTimeout(p.timer); pending.delete(record.id); p.resolve(record); }
      } catch { for (const p of pending.values()) p.reject(new Error(`non-MCP stdout: ${line}`)); }
    }
  });
  const exited = new Promise<void>(done => child.once('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MCP exited: ${stderr}`)); } done(); }));
  const ask = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
    const requestId = ++id;
    if (loseNext) { lostReplyId = requestId; loseNext = false; }
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP timeout: ${stderr}`)); }, 10_000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params: { ...params, ...(modern ? { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } : {}) } }) + '\n');
  });
  return { records, loseNextReply: () => { loseNext = true; }, droppedReplies: () => dropped, diagnostics: () => stderr, ask, call: (operation: OperationName, args: object = {}) => ask('tools/call', { name: names[operation], arguments: args }),
    initialize: async () => {
      if (modern) return ask('tools/list');
      const result = await ask('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
      assert.equal(result.result.protocolVersion, '2025-11-25');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return ask('tools/list');
    }, terminate: async () => { terminated = true; child.kill('SIGKILL'); await exited; assert.equal(child.signalCode, 'SIGKILL'); assert.throws(() => process.kill(child.pid!, 0)); }, close: async () => {
      child.stdin.end(); const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
      await exited; clearTimeout(kill);
      if (terminated) assert.equal(child.signalCode, 'SIGKILL'); else assert.equal(child.exitCode, 0, stderr);
      assert.equal(buffer, '');
      for (const record of records) assert.equal(record.jsonrpc, '2.0');
    } };
}

function output(operation: OperationName, reply: any) {
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.notEqual(reply.result.isError, true, JSON.stringify(reply));
  assert.deepEqual(JSON.parse(reply.result.content[0].text), reply.result.structuredContent);
  return decodeOperationOutput(operation, reply.result.structuredContent) as any;
}
// Only fixture-owned Git may reach the real process owner. Installer commands require the explicit fake.
function fixtureProcesses(delegate: Processes['Service'], root: string, sourceUrl?: string): Processes['Service'] {
  const roots=[resolve(root),existsSync(root)?realpathSync(root):resolve(root)];
  const inside=(path:string)=>roots.some(owned=>resolve(path)===owned||resolve(path).startsWith(owned+sep));
  return {run:command=>Effect.suspend(()=>{
    if(command.cmd!=='git') return Effect.die(new Error('Unfaked external command refused by MCP fixture'));
    const args=command.args.map(arg=>sourceUrl && arg==='https://github.com/owner/repo.git'?sourceUrl:arg);
    const at=args.indexOf('-C');
    const directory=command.cwd??(at>=0?args[at+1]:args.includes('clone')?args.at(-1):undefined);
    if(!directory || !inside(directory)) return Effect.die(new Error('Git outside fixture-owned paths refused'));
    if(args.some(arg=>arg.startsWith('file:') && arg!==sourceUrl && !inside(fileURLToPath(arg)))) return Effect.die(new Error('Non-fixture file remote refused'));
    if(args.some(arg=>/^(?:https?:|git@|ssh:)/.test(arg))) return Effect.die(new Error('Unrouted Git remote refused'));
    return delegate.run({...command,args,envAllow:[],env:{...command.env,PATH:process.env.PATH!,HOME:root,USERPROFILE:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_ALLOW_PROTOCOL:'file'}});
  })};
}
test('MCP fixture refuses unfaked installers and non-fixture Git before the real process owner',async()=>{
  let launches=0;
  const guard=fixtureProcesses({run:()=>{launches++;return Effect.succeed({code:0,stdout:''});}},'/tmp/owned-fixture');
  for(const command of [{cmd:'npx',args:['--yes','skills@1.7.2','add','owner/repo'],output:'capture' as const,cwd:'/tmp/owned-fixture'},
    {cmd:'codex',args:['exec'],output:'capture' as const,cwd:'/tmp/owned-fixture'},
    {cmd:'git',args:['status'],output:'capture' as const,cwd:'/private/other'}]) {
    const result=await Effect.runPromise(Effect.exit(guard.run(command)));assert.ok(Exit.isFailure(result));
  }
  assert.equal(launches,0);
});
async function agent(identity: 'app' | 'cli' = 'app', inputs: { metadata?: boolean; integrationsJson?: string; failPruneAt?: number; unavailableSourceDiagnostic?: (text: string) => void; sourceDecisions?: boolean; localSource?: boolean; sourceReads?: {url:string;from:string}; nativeOutput?: string; profileJson?: string; pinsJson?: string; skillCandidates?: Parameters<typeof makeSession>[1]['skillCandidates']; addition?: boolean; skillVerification?: Parameters<typeof makeSession>[1]['skillVerification'] } = {}) {
  const m = agentMachine('/tmp');
  const { nativeOutput, profileJson, pinsJson } = inputs;
  if(inputs.sourceDecisions) {
    assert.ok(inputs.sourceReads);
    commitFiles(m.paths.repo,'source author',{'skills-manifest.txt':'[owner/repo]\none\ntwo\n','skill-pins.json':JSON.stringify({version:1,pins:{'owner/repo':inputs.sourceReads.from}}),'source-ignores.json':'{"version":1,"ignored":{},"note":"keep"}\n'});
    m.write(join(m.paths.repo,'skill-pins.json'),'{\r\n  "version": 1,\r\n  "pins": {"owner/repo": "'+inputs.sourceReads.from+'"}\r\n}\r\n');
  }
  if(inputs.localSource) {
    const base=commitFiles(m.paths.repo,'local baseline',{'skills/one/SKILL.md':'old','skills-manifest.txt':'# author manifest\n','skill-pins.json':'{"version":1,"pins":{}}\n','source-ignores.json':'{}\n'});
    const branch=gitSync(m.paths.repo,'symbolic-ref','--short','HEAD');
    gitSync(m.paths.repo,'update-ref',`refs/remotes/origin/${branch}`,base);
    gitSync(m.paths.repo,'branch',`--set-upstream-to=origin/${branch}`);
    commitFiles(m.paths.repo,'unpushed local change',{'skills/one/notes.md':'local note'});
    m.write(join(m.paths.repo,'skills/one/SKILL.md'),'dirty tracked\n'+'L'.repeat(40000));
    m.write(join(m.paths.repo,'skills/new/SKILL.md'),'untracked new skill');
  }
  const fixture = setupFixture(join(m.root, 'setup'), { headFiles: {
    ...(nativeOutput === undefined ? {} : { 'integrations.json': JSON.stringify({ version: 1, integrations: [
      { id: 'fixture-mcp', label: 'fixture MCP', target: 'codex', type: 'mcp', default: true, command: 'fixture-server' },
    ] }) }),
    ...(inputs.integrationsJson === undefined ? {} : { 'integrations.json': inputs.integrationsJson }),
    ...(profileJson === undefined ? {} : { 'claude/settings.keys.json': profileJson }),
    ...(pinsJson === undefined ? {} : { 'skill-pins.json': pinsJson }),
    ...(inputs.localSource ? {'skills-manifest.txt':`[${pathToFileURL(m.paths.repo).href}]\none\n`}:{}),
    ...(inputs.sourceReads ? {'skills-manifest.txt':'[owner/repo]\none\ntwo\n','skill-pins.json':JSON.stringify({version:1,pins:{'owner/repo':inputs.sourceReads.from}})}:{}),
  } });
  m.write(join(m.paths.claude, 'settings.json'), '{"theme":"dark"}\n');
  await m.trust();
  await m.run(DecisionsStore.use(s => s.record(accept(EFFORT))));
  await m.run(AgentStateStore.use(s => s.update(state => ({ ...state, installedBy: identity, agentVersion: expectedRuntime, appPath: expectedApp }))));
  m.write(join(m.root, 'runtime.json'), JSON.stringify({ target: 'darwin-arm64', agentVersion: expectedRuntime, appVersion: '0.1.6' }));
  const started = Deferred.makeUnsafe<void>(), release = Deferred.makeUnsafe<void>();
  const config: AgentDomain = { ...configDomain, run: (step, report) => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Deferred.await(release); return yield* configDomain.run(step, report); }) };
  const domains = (paths: typeof m.paths) => {
    const integrations = integrationsDomain({ paths, env: {} });
    return [...(inputs.addition ? [skillsDomain] : []), config, nativeOutput === undefined ? integrations : {
      ...integrations,
      inspect: (desired: Parameters<typeof integrations.inspect>[0]) => integrations.inspect(desired).pipe(
        Effect.provideService(Processes, { run: () => Effect.succeed({ code: 0, stdout: nativeOutput, stderr: 'FAKE_STDERR' }) }),
      ),
    }];
  };
  // The older source fixture returns static profiles. Addition fixtures must compose fresh overrides,
  // as the production SetupSource does, so a saved declaration is visible to the driver's reinspection.
  const compose = <T extends { repo: string }>(snapshot: T) => Effect.gen(function* () {
    const overrides = yield* Effect.promise(() => m.run(OverridesStore.use(store => store.read)));
    const desired = yield* loadProfile(snapshot.repo, { overrides }).pipe(Effect.provide(nodeFiles));
    return { ...snapshot, desired };
  }).pipe(Effect.orDie);
  const source = inputs.addition ? Layer.succeed(SetupSource, { ...fixture.service,
    current: fixture.service.current.pipe(Effect.flatMap(compose)),
    load: revision => fixture.service.load(revision).pipe(Effect.flatMap(compose)),
    effective: decisions => fixture.service.effective(decisions).pipe(Effect.flatMap(value => Effect.gen(function* () {
      return { ...value, applied: yield* compose(value.applied), effective: yield* compose(value.effective) };
    }))),
  }) : fixture.source;
  const scope = Scope.makeUnsafe();
  const metadataPatches: Parameters<HostedClient['enqueueMachine']>[0][] = [];
  const metadataState = (): HostedState => ({ accountId: 'fixture-account', login: 'fixture', machineId: 'fixture-machine', auth: 'signed-in', setups: [],
    machine: { policy: 'notify', reportStatus: metadataPatches.at(-1)?.reportStatus ?? true }, confirmedMachine: { policy: 'notify', reportStatus: true },
    pendingMachinePatches: metadataPatches, machinePersistence: metadataPatches.length ? 'locally-queued' : 'confirmed', lastSyncAt: null, retryAt: null, pollAfter: 900, error: null });
  await m.run(Effect.gen(function* () {
    const processes=fixtureProcesses(yield* Processes,m.root,inputs.sourceReads?.url);
    const hosted = inputs.metadata ? yield* makeHostedRuntime({
      registerSetup: () => Effect.die('Unexpected setup registration'),
      publishRevision: () => Effect.die('Unexpected publication'),
      listRevisions: () => Effect.succeed([]),
      publicSetup: () => Effect.die('Unexpected public setup read'),
      subscribe: () => Effect.void,
      unsubscribe: () => Effect.void,
      state: Effect.sync(metadataState), signInFlow: Effect.succeed(null), recover: () => Effect.sync(metadataState), sync: () => Effect.sync(metadataState),
      revisions: () => Effect.succeed([]), reportStatus: () => Effect.void, enqueueDecision: () => Effect.die('Unexpected decision'),
      enqueueMachine: patch => Effect.sync(() => { metadataPatches.push(patch); }),
      startSignIn: () => Effect.die('Unexpected sign-in'), pollSignIn: () => Effect.die('Unexpected poll'), signOut: () => Effect.die('Unexpected sign-out'),
    } satisfies HostedClient, { domains, os: 'macos' }).pipe(Effect.provideService(Processes, processes)) : undefined;
    const handle = yield* startAgent(domains, { hosted }).pipe(Effect.provideService(Processes,processes));
    const sessionProcesses:Processes['Service']={run:command=>inputs.addition && command.cmd==='npx' ? Effect.gen(function*(){
      yield* Deferred.succeed(started,undefined);yield* Deferred.await(release);return {code:0,stdout:''};
    }) : inputs.unavailableSourceDiagnostic && command.cmd === 'git' && command.args.includes(pathToFileURL(join(m.root, 'unavailable-source')).href)
      ? processes.run({ ...command, stderr: 'capture' }).pipe(Effect.tap(result => Effect.sync(() => inputs.unavailableSourceDiagnostic!(result.stderr ?? ''))))
      : processes.run(command)};
    const fs = yield* Fs; let pruneAttempts = 0;
    const session=yield* makeSession(handle,{signal:new AbortController().signal,domains,skillCandidates:inputs.skillCandidates,skillVerification:inputs.skillVerification}).pipe(
      Effect.provide(agentSkillInstaller({home:join(m.root,'home')})),
      Effect.provide(sourceEnvironment({PATH:process.env.PATH!,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_ALLOW_PROTOCOL:'file'})),
      Effect.provideService(Processes,sessionProcesses),
      Effect.provideService(Fs, { ...fs, remove: path => path.startsWith(m.paths.backups + '/') && ++pruneAttempts === inputs.failPruneAt
        ? Effect.fail(new FsFailed({ op: 'remove', path, reason: 'PRIVATE-PRUNE-ERROR' })) : fs.remove(path) }),
    );
    yield* serveIpc({ paths: m.paths, handle, session, agentVersion: expectedRuntime, appRuntime: { version: '0.1.6', runtimeId: expectedRuntime, appDirectory: dirname(expectedApp), platform: 'darwin', target: 'darwin-arm64', metadataPath: join(m.root, 'runtime.json') }, onShutdown: () => {} });
    while ((yield* handle.status) === undefined) yield* Effect.sleep('10 millis');
  }).pipe(Scope.provide(scope)), source);
  return { m, metadataPatches, started, release, close: async () => { Deferred.doneUnsafe(release, Effect.void); await Effect.runPromise(Scope.close(scope, Exit.void)); rmSync(m.root, { recursive: true, force: true }); assert.equal(existsSync(m.root),false); } };
}

const runtimes = [...(nativeRuntime && packagedResources ? [expectedApp] : []), process.execPath, process.env.DESKTOP_MCP_BUN_RUNTIME ?? execFileSync('bun', ['-e', 'console.log(process.execPath)'], { encoding: 'utf8' }).trim()];
for (const runtime of runtimes) for (const modern of [false, true]) {
  test(`${runtime}: ${modern ? 'modern' : 'legacy'} safe historical diagnostics and malformed timestamps use authenticated MCP`, {timeout:30000}, async t => {
    const s=await agent();t.after(s.close);
    const at='2099-10-15T00:00:00.000Z', diagnostic='Failed to parse private input: password=fixture-only-value';
    const raw=[
      {kind:'future-one',at,private:diagnostic},
      {kind:'paused',at,reason:diagnostic},
      {kind:'future-malformed',at:{toString:0},private:diagnostic},
      {kind:'future-bad-calendar',at:'2099-02-30T00:00:00Z'},
      {kind:'resumed',at,reason:`was paused: ${diagnostic}`},
      {kind:'apply-finished',at,runId:'safe-history',backup:null,result:'done',steps:[{key:'config:one',outcome:'failed',note:diagnostic}]},
      {kind:'future-two',at,private:diagnostic},
    ].map(event=>({v:1,actor:'cli',...event}));
    s.m.write(join(s.m.paths.stateRoot,'history','2099-10.jsonl'),raw.map(e=>JSON.stringify(e)).join('\n')+'\n');
    const client=open(runtime,s.m.paths.stateRoot,modern);t.after(client.close);await client.initialize();
    const events:any[]=[],sequences:number[]=[];let before;
    for(let i=0;i<5;i++){
      const page=output('history',await client.call('history',{limit:1,...(before?{before}:{})}));
      events.push(...page.events);before=page.nextBefore;sequences.push(before.seq);
    }
    assert.deepEqual(events.map(e=>e.kind),['unknown','apply-finished','resumed','paused','unknown']);
    assert.deepEqual(sequences,[4,3,2,1,0]);assert.deepEqual(events[0],events[4]);
    assert.deepEqual(events[1].steps,[{key:'config:one',outcome:'failed',note:'Step failed'}]);
    assert.equal(events[2].detail.reason,'Application pause cleared');assert.equal(events[3].detail.reason,'Automatic application paused');
    assert.doesNotMatch(JSON.stringify(events),/fixture-only-value|password=|Failed to parse private input|was paused:/);
  });
  test(`${runtime}: ${modern ? 'modern' : 'legacy'} History and retention use authenticated MCP`, {timeout:30000}, async t => {
    const s=await agent();t.after(s.close);
    const folder=(i:number)=>`nortuscc-${new Date(Date.UTC(2020,0,1)-i*86400000).toISOString().replace(/[:.]/g,'-')}`;
    const ids=Array.from({length:24},(_,i)=>folder(i));
    for(const id of ids.slice(0,22))mkdirSync(join(s.m.paths.backups,id),{recursive:true});
    const at='2099-10-15T00:00:00.000Z';
    const raw=[
      {kind:'decided',setupId:'setup',itemId:'skill:owner/repo/name',revision:2,commit:null,decision:'accept'},
      {kind:'policy-changed',from:'manual',to:'notify',origin:'local'},
      {kind:'paused',reason:'fixture pause'},
      {kind:'future',message:'PRIVATE-HISTORY',runId:'PRIVATE-HISTORY',userCode:'PRIVATE-HISTORY'},
      {kind:'decided',setupId:{token:'PRIVATE-HISTORY'},decision:'accept'},
      {kind:'apply-finished',runId:'historic',steps:[],backup:join(s.m.paths.backups,ids[21]!),result:'done'},
    ].map(event=>({v:1,at,actor:'mcp',...event}));
    s.m.write(join(s.m.paths.stateRoot,'history','2099-10.jsonl'),raw.map(e=>JSON.stringify(e)).join('\n')+'\n');
    const client=open(runtime,s.m.paths.stateRoot,modern);t.after(client.close);await client.initialize();
    const first=output('listBackups',await client.call('listBackups',{limit:1}));assert.equal(first.folders[0].id,ids[0]);assert.ok(first.nextCursor);
    const second=output('listBackups',await client.call('listBackups',{limit:1,cursor:first.nextCursor}));assert.equal(second.folders[0].id,ids[1]);
    assert.equal(output('listBackups',await client.call('listBackups',{limit:100})).folders.find((f:any)=>f.id===ids[21]).latestReferenced,true);
    assert.equal((await client.call('listBackups',{limit:101})).result.isError,true);
    assert.equal((await client.call('listBackups',{limit:1,path:'/private'})).result.isError,true);
    const history:any[]=[];let before;
    for(let i=0;i<6;i++){
      const page=output('history',await client.call('history',{limit:1,...(before?{before}:{})}));
      history.push(...page.events);before=page.nextBefore;
    }
    assert.deepEqual(history.map(e=>e.kind),['apply-finished','unknown','unknown','paused','policy-changed','decided']);
    assert.deepEqual(history.at(-1).detail,{kind:'decision',setupId:'setup',itemId:'skill:owner/repo/name',revision:2,commit:null,choice:'accept'});
    assert.doesNotMatch(JSON.stringify(history),/PRIVATE-HISTORY|userCode|pendingId|signInFlow/);
    mkdirSync(join(s.m.paths.backups,ids[22]!));
    assert.equal((await client.call('listBackups',{limit:1,cursor:first.nextCursor})).result.isError,true);
    const stale=output('previewChange',await client.call('previewChange',{change:{kind:'pruneBackups'}}));
    mkdirSync(join(s.m.paths.backups,ids[23]!));
    assert.equal((await client.call('applyChange',{planId:stale.planId,requestId:'stale-retention'})).result.isError,true);
    for(const id of ids)assert.ok(existsSync(join(s.m.paths.backups,id)));
    const preview=output('previewChange',await client.call('previewChange',{change:{kind:'pruneBackups'}}));
    assert.deepEqual(preview.retention.folderIds,[ids[20],ids[22],ids[23]]);assert.equal(preview.retention.keepId,ids[21]);
    const request={planId:preview.planId,requestId:'exact-retention'};
    let run=output('applyChange',await client.call('applyChange',request)).run;
    for(let i=0;i<200&&!run.result;i++){await new Promise(r=>setTimeout(r,10));run=output('getRun',await client.call('getRun',{runId:run.runId}));}
    assert.equal(run.state,'succeeded');assert.deepEqual(run.parity.committedKeys,preview.retention.folderIds);
    for(const id of ids)assert.equal(existsSync(join(s.m.paths.backups,id)),!preview.retention.folderIds.includes(id));
    const next=open(runtime,s.m.paths.stateRoot,modern);t.after(next.close);await next.initialize();
    assert.equal(output('applyChange',await next.call('applyChange',request)).run.runId,run.runId);
    const after=output('history',await next.call('history',{limit:100}));
    const pruned=after.events.find((e:any)=>e.kind==='backups-pruned');assert.equal(pruned.runId,run.runId);assert.equal(pruned.requestId,request.requestId);
    assert.deepEqual(pruned.detail,{kind:'backups',ids:preview.retention.folderIds,pruned:true});
  });
  test(`${runtime}: ${modern ? 'modern' : 'legacy'} account and policy operations use authenticated MCP`, {timeout:30000}, async t => {
    const s=await agent();t.after(s.close);
    const client=open(runtime,s.m.paths.stateRoot,modern);t.after(client.close);await client.initialize();
    for(const section of ['status','pending','drift','conflicts']) {
      const result=output('agentStatus',await client.call('agentStatus',{section,limit:1}));
      assert.equal(result.section,section);assert.ok(result.items.length<=1);
    }
    for(const section of ['account','setups','machine']) {
      const result=output('accountState',await client.call('accountState',{section,limit:1}));
      assert.equal(result.section,section);assert.equal(result.enabled,false);
    }
    assert.equal((await client.call('accountState',{section:'account',token:'secret'})).result.isError,true);
    assert.equal((await client.call('agentStatus',{section:'pending',limit:101})).result.isError,true);
    for(const change of [{kind:'setPolicy',policy:'manual'},{kind:'resume'}]) {
      const preview=output('previewChange',await client.call('previewChange',{change}));
      const request={planId:preview.planId,requestId:`account-${change.kind}`};
      const accepted=output('applyChange',await client.call('applyChange',request));
      let run=accepted.run;
      for(let i=0;i<200 && !run.result;i++){await new Promise(r=>setTimeout(r,10));run=output('getRun',await client.call('getRun',{runId:run.runId}));}
      assert.equal(run.state,'succeeded');assert.equal(run.parity.kind,change.kind);
      assert.equal(output('applyChange',await client.call('applyChange',request)).run.runId,run.runId);
    }
    const status=output('agentStatus',await client.call('agentStatus',{section:'status'}));assert.equal(status.items[0].policy,'manual');
    assert.equal((await client.call('previewChange',{change:{kind:'signIn'}})).result.isError,true);
    assert.equal((await client.call('previewChange',{change:{kind:'pause'}})).result.isError,true);
    assert.doesNotMatch(JSON.stringify(client.records.filter(r=>r.result?.structuredContent)),/nmt_|userCode|pendingId/);
  });
  test(`${runtime}: ${modern ? 'modern' : 'legacy'} trusted local edits use authenticated MCP`, {timeout:30000}, async t => {
    const s=await agent('app',{localSource:true});t.after(s.close);
    const id=sourceIdentity(pathToFileURL(s.m.paths.repo).href);
    const index=readFileSync(join(s.m.paths.repo,'.git/index')),head=gitSync(s.m.paths.repo,'rev-parse','HEAD');
    const before=['skills/one/SKILL.md','skills/new/SKILL.md','skills-manifest.txt','skill-pins.json','source-ignores.json'].map(p=>[p,s.m.read(join(s.m.paths.repo,p))]);
    const client=open(runtime,s.m.paths.stateRoot,modern);t.after(client.close);await client.initialize();
    output('inspect',await client.call('inspect'));
    const watch=output('watchSources',await client.call('watchSources'));
    const local=watch.items[0]?.local;assert.ok(local);assert.equal(local.status,'edits');assert.ok(local.branch);assert.equal(local.unpushed[0]?.subject,'unpushed local change');assert.deepEqual(local.skills.map((s:any)=>s.name),['new','one']);
    assert.ok(!JSON.stringify(watch).includes(s.m.root));
    const select={sourceId:id,localObservation:local.observation,skillId:`skill:${id}/one`};
    const diff=output('inspectSourceDiff',await client.call('inspectSourceDiff',select));assert.equal(diff.state,'limited');assert.ok(diff.nextCursor);
    const rest=output('inspectSourceDiff',await client.call('inspectSourceDiff',{...select,cursor:diff.nextCursor}));assert.ok((diff.text+rest.text).includes('L'.repeat(40000)));
    const added=output('inspectSourceDiff',await client.call('inspectSourceDiff',{...select,skillId:`skill:${id}/new`}));assert.match(added.text,/untracked new skill/);
    assert.equal(gitSync(s.m.paths.repo,'rev-parse','HEAD'),head);assert.deepEqual(readFileSync(join(s.m.paths.repo,'.git/index')),index);
    for(const [p,bytes] of before) assert.equal(s.m.read(join(s.m.paths.repo,p!)),bytes);
    s.m.write(join(s.m.paths.repo,'skills/new/SKILL.md'),'new observation');
    assert.equal((await client.call('inspectSourceDiff',{...select,cursor:diff.nextCursor})).result.isError,true);
  });
  test(`${runtime}: ${modern ? 'modern' : 'legacy'} four source reads use authenticated MCP`, {timeout:30000}, async t => {
    const root=tempDir(t),repo=makeRepo(root);
    const from=repo.commit('baseline',{'skills/one/SKILL.md':'old','skills/two/SKILL.md':'same'});
    const to=repo.commit('update',{'skills/one/SKILL.md':'new','skills/added/SKILL.md':'added'});
    const s=await agent('app',{sourceReads:{url:repo.url,from}});t.after(s.close);
    const client=open(runtime,s.m.paths.stateRoot,modern);t.after(client.close);await client.initialize();
    output('inspect',await client.call('inspect'));
    const watch=output('watchSources',await client.call('watchSources'));
    assert.equal(watch.items[0].toRevision,to);assert.equal(watch.state,'complete');
    const impact=output('pinImpact',await client.call('pinImpact',{sourceId:'owner/repo',revision:to}));assert.equal(impact.skills.length,2);
    const pair={sourceId:'owner/repo',fromRevision:from,toRevision:to};
    const diff=output('inspectSourceDiff',await client.call('inspectSourceDiff',{...pair,skillId:'skill:owner/repo/one'}));assert.match(diff.text,/new/);
    const draft=output('draftChangelog',await client.call('draftChangelog',{accepted:[{...pair,ignored:['one'],added:['added']}]}));assert.match(draft.text,/Also updated: `one`/);assert.match(draft.text,/Added `added`/);
    assert.equal((await client.call('watchSources',{path:'/private'})).result.isError,true);
    assert.equal((await client.call('pinImpact',{sourceId:'unknown/repo',revision:to})).result.isError,true);
  });
  test(`${runtime}: retired source decisions cannot write through MCP`, async t => {
    const s = await agent(); t.after(s.close);
    const client = open(runtime, s.m.paths.stateRoot, modern); t.after(client.close); await client.initialize();
    assert.equal(output('getContext', await client.call('getContext')).capabilities.sourceDecision.available, false);
    const reply = await client.call('previewChange', { change: { kind: 'sourceDecision', sourceId: 'owner/repo', action: 'unpin' } });
    assert.equal(reply.result.isError, true);
  });
  test(`${runtime}: ${modern ? 'modern 2026' : 'legacy 2025'} opening, shared tools and reconnectable agent runs`, { timeout: 30_000 }, async t => {
    const s = await agent(); t.after(s.close);
    const client = open(runtime, s.m.paths.stateRoot, modern); t.after(client.close);
    const listed = await client.initialize();
    assert.equal(listed.error, undefined, JSON.stringify(listed));
    assert.deepEqual(listed.result.tools.map((tool: any) => tool.name).sort(), Object.values(names).sort());
    for (const [operation, name] of Object.entries(names)) {
      const tool = listed.result.tools.find((tool: any) => tool.name === name);
      assert.deepEqual(tool.inputSchema, { type: 'object', ...operationJsonSchemas[operation as OperationName].input });
      assert.deepEqual(tool.outputSchema, { type: 'object', ...operationJsonSchemas[operation as OperationName].output });
    }
    assert.equal(output('getContext', await client.call('getContext')).app.ownership, 'app');
    output('inspect', await client.call('inspect'));
    const setups=output('inspectSetups',await client.call('inspectSetups',{limit:1})); assert.equal(setups.items[0].setupId,'local'); assert.equal(setups.items[0].trusted,true);
    const incoming=output('incomingChanges',await client.call('incomingChanges',{setupId:'local',limit:1})); assert.equal(incoming.revision.kind,'local'); assert.equal(incoming.revision.commit,'b'.repeat(40)); assert.equal(incoming.items.length,1);
    const absentHeld = 'setting:claude:settings.json#model';
    s.m.write(join(s.m.paths.stateRoot, 'sync.json'), JSON.stringify({ version: 1, held: { [absentHeld]: 'a'.repeat(40) } }));
    const heldRows = output('incomingChanges', await client.call('incomingChanges', { setupId: 'local' }));
    const heldRow = heldRows.items.find((item: any) => item.itemId === absentHeld);
    assert.deepEqual(heldRow, { itemId: absentHeld, kind: 'setting', revision: incoming.revision, change: 'unchanged', held: true, conflict: false });
    output('previewChange', await client.call('previewChange', { change: { kind: 'syncDecision', setupId: 'local', revision: heldRow.revision, itemId: heldRow.itemId, action: 'release' } }));
    assert.throws(() => decodeOperationOutput('incomingChanges', { ...heldRows, items: [{ ...heldRow, held: false }] }));
    assert.throws(() => decodeOperationOutput('incomingChanges', { ...heldRows, items: [{ ...heldRow, revision: { kind: 'hosted', number: 1, commitSha: 'b'.repeat(40) } }] }));
    s.m.write(join(s.m.paths.stateRoot, 'sync.json'), JSON.stringify({ version: 1, held: {} }));
    const trust=output('prepareTrustRequest',await client.call('prepareTrustRequest',{setupId:'local'})); assert.equal(trust.action,'open-app-repository-trust'); assert.equal(trust.trusted,true);
    const updates = output('inspectUpdates', await client.call('inspectUpdates', { limit: 1 }));
    assert.deepEqual(updates.items, []); assert.equal(updates.unavailable, false);
    const invalid = await client.call('previewChange', { change: { kind: 'reconcile', only: [], force: 'invalid' } });
    assert.equal(invalid.result.isError, true); assert.ok(invalid.result.content[0].text.length < 600);
    const refused = await client.call('inspect', { scope: { kind: 'user' } });
    assert.equal(refused.result.isError, true); assert.equal(refused.result.structuredContent.error.code, 'UNSUPPORTED_SCOPE');
    const preview = output('previewChange', await client.call('previewChange', { change: { kind: 'reconcile', only: ['config:claude:settings.json#effortLevel'] } }));
    const applied = output('applyChange', await client.call('applyChange', { planId: preview.planId, requestId: 'caller-owned-intent' }));
    assert.equal(applied.status, 'started');
    await Effect.runPromise(Deferred.await(s.started));
    assert.equal(output('getRun', await client.call('getRun', { runId: applied.run.runId })).result, null);
    if (runtime === expectedApp && modern) await client.terminate(); else await client.close();
    const next = open(runtime, s.m.paths.stateRoot, modern); t.after(next.close); await next.initialize();
    assert.equal(output('getRun', await next.call('getRun', { runId: applied.run.runId })).intent.requestId, 'caller-owned-intent');
    assert.equal(output('applyChange', await next.call('applyChange', { planId: preview.planId, requestId: 'caller-owned-intent' })).run.runId, applied.run.runId);
    assert.equal(output('listRuns', await next.call('listRuns', { limit: 10 })).runs.length, 1);
    Deferred.doneUnsafe(s.release, Effect.void);
    let run = output('getRun', await next.call('getRun', { runId: applied.run.runId }));
    while (run.result === null) run = output('getRun', await next.call('getRun', { runId: applied.run.runId }));
    assert.equal(output('cancelRun', await next.call('cancelRun', { runId: applied.run.runId })).state, 'succeeded');
    const history = output('history', await next.call('history', { limit: 100 }));
    assert.ok(history.events.some((event: any) => event.actor === 'mcp' && event.requestId === 'caller-owned-intent'));
  });
}

for (const runtime of [process.execPath, ...(nativeRuntime && packagedResources ? [expectedApp] : [])]) test(`${runtime}: CLI-owned agent exposes context diagnostics but cannot execute shared operations`, async t => {
  const s = await agent('cli'); t.after(s.close);
  const client = open(runtime, s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  assert.ok(output('getContext', await client.call('getContext')).diagnostics.length > 0);
  const refused = await client.call('inspect'); assert.equal(refused.result.structuredContent.error.code, 'APP_UNAVAILABLE');
});

test('malformed replies and private failure codes are redacted and an identical-runtime app relocation refuses the old MCP process', async t => {
  const root = mkdtempSync('/tmp/mcp-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const { mkdirSync } = await import('node:fs'); mkdirSync(join(root, 'agent'));
  writeFileSync(join(root, 'agent/agent.token'), 'fixture-secret-token');
  const registration = { version: 1, installedBy: 'app', agentVersion: expectedRuntime, appPath: expectedApp };
  writeFileSync(join(root, 'agent/agent.json'), JSON.stringify(registration));
  let operations = 0;
  let privateFailure: false | string = false;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = ''; socket.on('data', chunk => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (request.command === 'hello') { assert.equal(request.client, 'mcp'); assert.equal(request.runtimeId, expectedRuntime); assert.equal(request.token, 'fixture-secret-token'); }
        if (request.command === 'operation') operations++;
        const result = request.command === 'hello' ? { agentVersion: expectedRuntime, protocol: 3, policy: 'manual', paused: null, operationsProtocol: 1, app: { ownership: 'app', version: '0.1.6', runtimeId: expectedRuntime }, operations: { available: true } } : { rawSecret: 'fixture-private-path-token' };
        const reply = request.command === 'operation' && privateFailure
          ? { version: 3, id: request.id, ok: false, error: { code: privateFailure, message: 'fixture-private-failure-message' } }
          : { version: 3, id: request.id, ok: true, result };
        socket.write(JSON.stringify(reply) + '\n');
      }
    });
  });
  await new Promise<void>(done => server.listen(join(root, 'agent/agent.sock'), done));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())); });
  const client = open(process.execPath, root); t.after(client.close); await client.initialize();
  const reply = await client.call('getRun', { runId: 'r' });
  assert.equal(reply.result.isError, true); assert.equal(reply.result.structuredContent.error.code, 'MALFORMED');
  assert.ok(!JSON.stringify(client.records).includes('fixture-private-path-token'));
  assert.ok(!JSON.stringify(client.records).includes('fixture-secret-token'));
  privateFailure = 'PRIVATE_SECRET_VALUE';
  const failure = await client.call('getRun', { runId: 'r' });
  assert.equal(failure.result.isError, true);
  assert.equal(failure.result.structuredContent.error.code, 'OPERATION_FAILED');
  assert.deepEqual(JSON.parse(failure.result.content[0].text), failure.result.structuredContent);
  for (const secret of ['PRIVATE_SECRET_VALUE', 'fixture-private-failure-message']) {
    assert.ok(!JSON.stringify(client.records).includes(secret));
    assert.ok(!client.diagnostics().includes(secret));
  }
  privateFailure = 'SKILL_INSTALL_UNAVAILABLE';
  const unavailable = await client.call('applyChange', { planId: 'p', requestId: 'r' });
  assert.equal(unavailable.result.structuredContent.error.code, 'SKILL_INSTALL_UNAVAILABLE');
  assert.match(unavailable.result.structuredContent.error.message, /native destination.*lock mapping/);
  assert.doesNotMatch(unavailable.result.structuredContent.error.message, /requires the durable/);
  writeFileSync(join(root, 'agent/agent.json'), JSON.stringify({ ...registration, appPath: '/tmp/Relocated.app/Contents/MacOS/Test' }));
  const relocated = await client.call('getContext');
  assert.equal(relocated.result.structuredContent.error.code, 'APP_UNAVAILABLE');
  assert.equal(operations, 3, 'the old MCP process must not reach an identical-version relocated agent');
  assert.ok(!JSON.stringify(client.records).includes(expectedApp));
  assert.ok(!JSON.stringify(client.records).includes('Relocated.app'));
});

for (const runtime of runtimes) test(`${runtime}: successful MCP inspect redacts malformed native listing diagnostics`, async t => {
  const sentinel = 'FAKE_TOKEN';
  const s = await agent('app', { nativeOutput: sentinel }); t.after(s.close);
  const client = open(runtime, s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  const inspected = output('inspect', await client.call('inspect'));
  assert.ok(inspected.probeErrors.some((note: string) => note.includes('could not read the Codex MCP server list')));
  for (const secret of [sentinel, 'FAKE_STDERR']) {
    assert.ok(!JSON.stringify(client.records).includes(secret));
    assert.ok(!client.diagnostics().includes(secret));
  }
});

for (const runtime of runtimes) test(`${runtime}: successful MCP inspect redacts malformed profile parser diagnostics`, async t => {
  const sentinel = 'FAKE_TOKEN';
  const s = await agent('app', { profileJson: sentinel }); t.after(s.close);
  const client = open(runtime, s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  const inspected = output('inspect', await client.call('inspect'));
  assert.ok(inspected.profile.issues.some((issue: { message: string }) => issue.message.includes('not valid JSON')));
  assert.ok(!JSON.stringify(client.records).includes(sentinel));
  assert.ok(!client.diagnostics().includes(sentinel));
});

for (const runtime of runtimes) test(`${runtime}: successful MCP inspect omits rejected profile schema keys`, async t => {
  const sentinel = 'FAKE_TOKEN';
  const s = await agent('app', { pinsJson: JSON.stringify({ version: 1, pins: {}, [sentinel]: 'private' }) }); t.after(s.close);
  const client = open(runtime, s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  const inspected = output('inspect', await client.call('inspect'));
  assert.ok(inspected.profile.issues.some((issue: { source: string }) => issue.source === 'skill-pins.json'));
  assert.ok(!JSON.stringify(client.records).includes(sentinel));
  assert.ok(!client.diagnostics().includes(sentinel));
});


test('MCP exposes bounded discovery and source-specific preview; a stale mutation refuses without intent writes', { timeout: 10_000 }, async t => {
  const source = 'owner/repo', revision = 'a'.repeat(40);
  const s = await agent('app', { skillCandidates: () => Effect.succeed({ ok: true, source, revision, candidates: [{ source, revision, installedName: 'design-review', selectorName: 'Design Review', sourceDir: 'skills/layout', description: 'Review design', tree: 'b'.repeat(40), blob: 'c'.repeat(40), internal: false, metadata: {} }] }) }); t.after(s.close);
  const client = open(process.execPath, s.m.paths.stateRoot); t.after(client.close);
  const listed = await client.initialize();
  for (const operation of ['resolveSkillCandidate', 'previewChange'] as const) {
    const tool = listed.result.tools.find((tool: any) => tool.name === names[operation]); assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.openWorldHint, true);
  }
  output('inspect', await client.call('inspect'));
  const found = output('resolveSkillCandidate', await client.call('resolveSkillCandidate', { source, name: 'DESIGN REVIEW' })); assert.equal(found.status, 'found');
  await client.close();
  const next = open(process.execPath, s.m.paths.stateRoot); t.after(next.close); await next.initialize();
  const beforeHistory = output('history', await next.call('history', { limit: 10 }));
  const preview = output('previewChange', await next.call('previewChange', { change: { kind: 'addSkill', candidateId: found.candidates[0].candidateId, targets: ['claude'] } }));
  assert.equal(preview.skillAddition.declaration.after.name, 'design-review'); assert.equal(preview.skillAddition.sharedStore.codexScans, true); assert.deepEqual(preview.nextActions, []);
  // Change composed intent after review. The durable driver must refuse before any installer.
  s.m.write(join(s.m.paths.stateRoot, 'overrides.json'), JSON.stringify({ version: 2, skills: { changed: false } }));
  const refused = await next.call('applyChange', { planId: preview.planId, requestId: 'stale-addition' }); assert.equal(refused.result.isError, true); assert.equal(refused.result.structuredContent.error.code, 'UNKNOWN_PLAN');
  assert.deepEqual(JSON.parse(s.m.read(join(s.m.paths.stateRoot, 'overrides.json'))!), { version: 2, skills: { changed: false } }); assert.deepEqual(output('listRuns', await next.call('listRuns', { limit: 10 })).runs, []);
  assert.equal(existsSync(s.m.paths.backups), false); assert.deepEqual(output('history', await next.call('history', { limit: 10 })), beforeHistory);
});


test('MCP addition guidance offers sharing and promotion only after verified completion', async t => {
  const s = await agent(); t.after(s.close);
  const client = open(process.execPath, s.m.paths.stateRoot); t.after(client.close);
  const listed = await client.initialize();
  const description = (name: OperationName) => listed.result.tools.find((tool: any) => tool.name === names[name]).description;
  assert.doesNotMatch(description('previewChange'), /currently unavailable/);
  assert.match(description('previewChange'), /selected native model catalogs/);
  assert.match(description('getRun'), /Do you want to share it with your other machines\?/);
  assert.match(description('getRun'), /promot.*profile/i);
  assert.match(description('getRun'), /only after.*verified/i);
  assert.match(description('getRun'), /user request/);
});


for (const runtime of runtimes) test(`${runtime}: MCP addition from arbitrary cwd retains one intent after a lost reply and offers blocked scope follow-ups`, { timeout: 15_000 }, async t => {
  const source = 'owner/repo', revision = 'a'.repeat(40);
  const candidate = { source, revision, installedName: 'design-review', selectorName: 'Design Review', sourceDir: 'skills/layout', description: 'Review design', tree: 'b'.repeat(40), blob: 'c'.repeat(40), internal: false, metadata: {} };
  const s = await agent('app', { addition: true,
    skillCandidates: () => Effect.succeed({ ok: true, source, revision, candidates: [candidate] }),
    skillVerification: { content: () => Effect.succeed({ verified: true, problems: [] }), codex: () => Effect.succeed({ verified: true, path: '/isolated/SKILL.md', enabled: true }) },
  }); t.after(s.close);
  const client = open(runtime, s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  const found = output('resolveSkillCandidate', await client.call('resolveSkillCandidate', { source, name: 'design-review' }));
  const preview = output('previewChange', await client.call('previewChange', { change: { kind: 'addSkill', candidateId: found.candidates[0].candidateId, targets: ['codex'] } }));
  assert.deepEqual(preview.nextActions, []);
  // Drop the caller's acceptance result and kill its transport after the installer has started.
  client.loseNextReply();
  const lost = client.call('applyChange', { planId: preview.planId, requestId: 'lost-addition-reply' }).catch(() => undefined);
  await Effect.runPromise(Deferred.await(s.started).pipe(Effect.timeout('5 seconds')));
  await client.terminate(); await lost;
  assert.equal(client.droppedReplies(), 1);
  const next = open(runtime, s.m.paths.stateRoot); t.after(next.close); await next.initialize();
  const listed = output('listRuns', await next.call('listRuns', { limit: 10 })); assert.equal(listed.runs.length, 1);
  const runId = listed.runs[0].runId;
  const pending = output('getRun', await next.call('getRun', { runId }));
  assert.equal(pending.intentState, 'saved'); assert.equal(pending.actor, 'mcp'); assert.equal(pending.installation?.nextActions.length ?? 0, 0);
  const retry = output('applyChange', await next.call('applyChange', { planId: preview.planId, requestId: 'lost-addition-reply' })); assert.equal(retry.run.runId, runId);
  Deferred.doneUnsafe(s.release, Effect.void);
  let done = output('getRun', await next.call('getRun', { runId }));
  while (!done.result) done = output('getRun', await next.call('getRun', { runId }));
  assert.equal(done.installation.state, 'verified'); assert.equal(done.actor, 'mcp');
  assert.deepEqual(done.scope, { kind: 'machine' });
  assert.deepEqual(done.intent.skillAddition.declaration, { source, name: 'design-review', targets: ['codex'] });
  assert.deepEqual(done.installation.nextActions.map((action: any) => [action.kind, action.capability.available, action.requiredDestination]), [
    ['share_with_my_machines', false, 'user'], ['promote_to_profile', false, 'profile'],
  ]);
  assert.match(done.installation.nextActions[0].capability.reason, /personal sharing workflow/);
  assert.match(done.installation.nextActions[1].capability.reason, /profile publication workflow/);
  const before = s.m.read(join(s.m.paths.stateRoot, 'overrides.json'));
  assert.deepEqual(output('getRun', await next.call('getRun', { runId })), done);
  assert.equal(s.m.read(join(s.m.paths.stateRoot, 'overrides.json')), before);
  assert.equal(output('listRuns', await next.call('listRuns', { limit: 10 })).runs.length, 1);
  const history = output('history', await next.call('history', { limit: 100 }));
  assert.ok(history.events.some((event: any) => event.kind === 'skill-addition' && event.actor === 'mcp' && event.runId === runId && event.requestId === 'lost-addition-reply'));
});


test('dedicated MCP intent read and reset recover one shared run after a lost acceptance reply', { timeout: 30_000 }, async t => {
  const s = await agent('app', { addition: true }); t.after(s.close);
  const client = open(process.execPath, s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  output('inspect', await client.call('inspect'));
  const initial = output('inspectIntent', await client.call('inspectIntent', { section: 'settings' }));
  assert.ok(initial.items.some((item: any) => item.kind === 'setting' && item.key === 'theme' && item.value === 'dark'));
  const preview = output('previewChange', await client.call('previewChange', { change: { kind: 'machineIntent', patch: { kind: 'setting', fileId: 'claude:settings.json', key: 'theme', action: 'reset' } } }));
  assert.equal(preview.plan.kind, 'operation'); assert.ok(preview.machineIntent.intentChanges.length);
  const args = { planId: preview.planId, requestId: 'mcp-intent-reset' };
  client.loseNextReply();
  const lost = client.call('applyChange', args).catch(() => undefined);
  for (let n = 0; n < 100 && client.droppedReplies() === 0; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(client.droppedReplies(), 1); await client.terminate(); await lost;
  const next = open(process.execPath, s.m.paths.stateRoot); t.after(next.close); await next.initialize();
  let run = output('applyChange', await next.call('applyChange', args)).run;
  for (let n = 0; n < 100 && !run.result; n++) {
    await new Promise(resolve => setTimeout(resolve, 10)); run = output('getRun', await next.call('getRun', { runId: run.runId }));
  }
  assert.equal(run.state, 'succeeded'); assert.equal(run.intentSaved, true); assert.equal(run.parity.kind, 'machineIntent');
  assert.equal(output('applyChange', await next.call('applyChange', args)).run.runId, run.runId);
  assert.equal(output('listRuns', await next.call('listRuns', { limit: 10 })).runs.length, 1);
  const saved = JSON.parse(s.m.read(join(s.m.paths.stateRoot, 'overrides.json'))!); assert.equal(saved.settings?.['claude:settings.json']?.theme, undefined);
});

test('selected MCP reconciliation and document restoration recover after a lost acceptance reply', { timeout: 30_000 }, async t => {
  const s = await agent(); t.after(s.close);
  const client = open(process.execPath, s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  output('inspect', await client.call('inspect'));
  const preview = output('previewChange', await client.call('previewChange', { change: { kind: 'reconcile', only: ['config:claude:settings.json#effortLevel'], targets: ['claude'], declined: ['hooks', 'mcp', 'plugins', 'skills'], force: false } }));
  assert.deepEqual(preview.plan.steps.map((step: any) => step.key), ['config:claude:settings.json#effortLevel']);
  Deferred.doneUnsafe(s.release, Effect.void);
  const first = output('applyChange', await client.call('applyChange', { planId: preview.planId, requestId: 'selected-reconcile' })).run;
  let applied = output('getRun', await client.call('getRun', { runId: first.runId }));
  while (!applied.result) applied = output('getRun', await client.call('getRun', { runId: first.runId }));
  assert.equal(applied.state, 'succeeded');
  output('inspect', await client.call('inspect'));
  const restore = output('previewChange', await client.call('previewChange', { change: { kind: 'uninstallConfig', only: ['config:claude:settings.json#effortLevel'], targets: ['claude'], force: false } }));
  assert.deepEqual(restore.plan.steps.map((step: any) => step.key), ['config:claude:settings.json']);
  assert.match(restore.actionEffects.join(' '), /all its recorded keys/);
  const args = { planId: restore.planId, requestId: 'restore-selected-document' };
  client.loseNextReply(); const lost = client.call('applyChange', args).catch(() => undefined);
  for (let n = 0; n < 100 && client.droppedReplies() === 0; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(client.droppedReplies(), 1); await client.terminate(); await lost;
  const next = open(process.execPath, s.m.paths.stateRoot); t.after(next.close); await next.initialize();
  let done = output('applyChange', await next.call('applyChange', args)).run;
  while (!done.result) done = output('getRun', await next.call('getRun', { runId: done.runId }));
  assert.equal(done.state, 'succeeded'); assert.equal(done.parity.kind, 'uninstallConfig');
  assert.deepEqual(done.parity.committedKeys, ['config:claude:settings.json']);
  assert.equal(output('applyChange', await next.call('applyChange', args)).run.runId, done.runId);
  assert.equal(output('listRuns', await next.call('listRuns', { limit: 10 })).runs.length, 2);
  assert.deepEqual(JSON.parse(s.m.read(join(s.m.paths.claude, 'settings.json'))!), { theme: 'dark' });
});

test('MCP refuses retired checkout capture from an arbitrary cwd', async t => {
  const s = await agent(); t.after(s.close);
  const before = s.m.read(join(s.m.paths.repo, 'claude/settings.keys.json'));
  const client = open(process.execPath, s.m.paths.stateRoot, true); t.after(client.close); await client.initialize();
  const reply = await client.call('previewChange', { change: { kind: 'capture', only: ['config:claude:settings.json#theme'], targets: ['claude'], takeLocal: true, allowShrink: false } });
  assert.equal(reply.result.isError, true);
  assert.equal(s.m.read(join(s.m.paths.repo, 'claude/settings.keys.json')), before);
});

test('dedicated MCP update read and explicit machine-only update recover a lost acceptance reply', { timeout: 30_000 }, async t => {
  const diagnostics: string[] = [];
  const s = await agent('app',{ addition: true, unavailableSourceDiagnostic: text => diagnostics.push(text) }); t.after(s.close);
  s.m.write(join(s.m.paths.agentsSkills,'known','SKILL.md'),'# local known\n');
  s.m.write(join(s.m.paths.agentsSkills,'..','.skill-lock.json'),JSON.stringify({ skills: { known: { source: 'owner/repo',sourceUrl: `file://${join(s.m.root,'unavailable-source')}`,skillPath:'s/known/SKILL.md',skillFolderHash:'a'.repeat(40) } } }));
  const client = open(process.execPath,s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  output('inspect',await client.call('inspect'));
  const read = output('inspectUpdates',await client.call('inspectUpdates',{ limit: 5 })); assert.equal(read.items[0].id,'skill:owner/repo/known'); assert.equal(read.items[0].state,'unknown'); assert.equal(read.items[0].repairRoute,'unavailable'); assert.equal(read.items[0].offered,null); assert.equal(read.unavailable,false);
  assert.doesNotMatch(JSON.stringify(read),/file:|unavailable-source|SKILL\.md/);
  const p = output('previewChange',await client.call('previewChange',{ change: { kind: 'update',only: [],authorManifest: false } }));
  const args = { planId: p.planId,requestId: 'lost-update-acceptance' }; client.loseNextReply(); const lost = client.call('applyChange',args).catch(() => undefined);
  for (let n=0;n<100 && !client.droppedReplies();n++) await new Promise(resolve => setTimeout(resolve,10)); assert.equal(client.droppedReplies(),1); await client.terminate(); await lost;
  const next = open(process.execPath,s.m.paths.stateRoot); t.after(next.close); await next.initialize();
  let run = output('applyChange',await next.call('applyChange',args)).run;
  for (let n=0;n<100 && !run.result;n++) { await new Promise(resolve => setTimeout(resolve,10)); run = output('getRun',await next.call('getRun',{ runId: run.runId })); }
  assert.equal(run.state,'succeeded'); assert.equal(run.parity.kind,'update'); assert.equal(output('listRuns',await next.call('listRuns',{ limit: 10 })).runs.length,1);
  assert.equal(diagnostics.length, 4);
  for (const diagnostic of diagnostics) assert.equal(diagnostic, `fatal: '${join(s.m.root, 'unavailable-source')}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n`);
});

test('authenticated MCP sync hold retains one decision run after a lost reply', {timeout:30000},async t=>{
 const s=await agent();t.after(s.close);const client=open(process.execPath,s.m.paths.stateRoot);t.after(client.close);await client.initialize();
 const incoming=output('incomingChanges',await client.call('incomingChanges',{setupId:'local'}));
 const preview=output('previewChange',await client.call('previewChange',{change:{kind:'syncDecision',setupId:'local',revision:incoming.revision,itemId:EFFORT,action:'hold'}}));
 const args={planId:preview.planId,requestId:'sync-held'};client.loseNextReply();const lost=client.call('applyChange',args).catch(()=>undefined);
 for(let n=0;n<100&&client.droppedReplies()===0;n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(client.droppedReplies(),1);await client.terminate();await lost;
 const next=open(process.execPath,s.m.paths.stateRoot);t.after(next.close);await next.initialize();let run=output('applyChange',await next.call('applyChange',args)).run;
 for(let n=0;n<100&&!run.result;n++){await new Promise(resolve=>setTimeout(resolve,10));run=output('getRun',await next.call('getRun',{runId:run.runId}));}
 assert.equal(run.state,'succeeded');assert.equal(run.actor,'mcp');assert.equal(run.parity.kind,'syncDecision');assert.ok(run.parity.committedKeys.includes('sync:hold'));assert.ok(run.parity.committedKeys.includes('sync:decision'));
 assert.equal(output('applyChange',await next.call('applyChange',args)).run.runId,run.runId);
 assert.equal(JSON.parse(s.m.read(join(s.m.paths.stateRoot,'sync.json'))!).held[EFFORT],'a'.repeat(40));
 const choices=await s.m.run(DecisionsStore.use(store=>store.read));assert.equal(choices.find(d=>d.itemId===EFFORT)?.decision,'skip');
 const held=output('incomingChanges',await next.call('incomingChanges',{setupId:'local'}));assert.equal(held.items.find((i:any)=>i.itemId===EFFORT).held,true);
});

test('every operation definition is an MCP tool and callable through the desktop adapter', async t => {
  const desktopAcceptsEveryOperation: OperationName extends Parameters<typeof operation>[1] ? true : false = true;
  assert.equal(desktopAcceptsEveryOperation, true);
  const s = await agent(); t.after(s.close);
  const client = open(process.execPath, s.m.paths.stateRoot); t.after(client.close);
  const listed = await client.initialize();
  const operationsByTool = new Map<string, string>(Object.entries(toolNames).map(([name, tool]) => [tool, name]));
  const mcpOperations = listed.result.tools.map((tool: { name: string }) => operationsByTool.get(tool.name));
  assert.deepEqual(new Set(Object.keys(operationDefinitions)), new Set(mcpOperations));
});

test('MCP descriptions explain semantic effects and recovery', async t => {
  const s = await agent(); t.after(s.close);
  const client = open(process.execPath, s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  const listed = await client.ask('tools/list');
  const description = listed.result.tools.find((tool: { name: string }) => tool.name === names.getRun).description;
  assert.match(description, /committed.*remaining/i); assert.match(description, /author destination/i); assert.match(description, /uncertain/i);
});

test('MCP partial retention preserves observed removals and reconnect never retries effects', async t => {
 const s=await agent('app',{failPruneAt:2});t.after(s.close);
 const ids=Array.from({length:23},(_,i)=>`nortuscc-${new Date(Date.UTC(2020,0,1)-i*86400000).toISOString().replace(/[:.]/g,'-')}`);
 for(const id of ids)mkdirSync(join(s.m.paths.backups,id),{recursive:true});
 const client=open(process.execPath,s.m.paths.stateRoot);t.after(client.close);await client.initialize();
 const preview=output('previewChange',await client.call('previewChange',{change:{kind:'pruneBackups'}}));
 const request={planId:preview.planId,requestId:'partial-retention'};
 let run=output('applyChange',await client.call('applyChange',request)).run;
 for(let i=0;i<200&&!run.result;i++){await new Promise(r=>setTimeout(r,10));run=output('getRun',await client.call('getRun',{runId:run.runId}));}
 assert.equal(run.state,'failed');assert.equal(run.parity.state,'needsInspection');
 assert.deepEqual(run.parity.committedKeys,[ids[20]]);assert.deepEqual(run.parity.remainingKeys,[ids[21],ids[22]]);
 assert.deepEqual(run.parity.backupIds,[]);assert.doesNotMatch(JSON.stringify(run),/PRIVATE-PRUNE-ERROR/);
 const next=open(process.execPath,s.m.paths.stateRoot);t.after(next.close);await next.initialize();
 assert.equal(output('applyChange',await next.call('applyChange',request)).run.runId,run.runId);
 for(const id of ids)assert.equal(existsSync(join(s.m.paths.backups,id)),id!==ids[20]);
});

for(const fence of ['maintenance','ownership','runtime'] as const)test(`MCP ${fence} fence refuses a previewed write`,async t=>{
 const s=await agent();t.after(s.close);const client=open(process.execPath,s.m.paths.stateRoot);t.after(client.close);await client.initialize();
 const preview=output('previewChange',await client.call('previewChange',{change:{kind:'setPolicy',policy:'manual'}}));
 if(fence==='maintenance')s.m.write(join(s.m.paths.stateRoot,'agent/pending-update.json'),'{}');
 else await s.m.run(AgentStateStore.use(store=>store.update(state=>({...state,...(fence==='ownership'?{installedBy:'cli' as const}:{agentVersion:'replacement'})}))));
 const applied=await client.call('applyChange',{planId:preview.planId,requestId:'fenced'});
 assert.equal(applied.result.isError,true);assert.equal(s.m.agentJson().policy,'notify');
 assert.equal(existsSync(join(s.m.paths.stateRoot,'agent/runs')),false);
});

test('MCP account metadata preserves queued intent and same-request identity', async t => {
 const s=await agent('app',{metadata:true});t.after(s.close);
 const client=open(process.execPath,s.m.paths.stateRoot);t.after(client.close);await client.initialize();
 const before=output('accountState',await client.call('accountState',{section:'machine'}));assert.equal(before.items[0].persistence,'confirmed');
 const preview=output('previewChange',await client.call('previewChange',{change:{kind:'patchMachineMetadata',patch:{reportStatus:false}}}));
 const request={planId:preview.planId,requestId:'metadata-queue'};
 let run=output('applyChange',await client.call('applyChange',request)).run;
 for(let i=0;i<200&&!run.result;i++){await new Promise(r=>setTimeout(r,10));run=output('getRun',await client.call('getRun',{runId:run.runId}));}
 assert.equal(run.state,'succeeded');assert.equal(run.parity.metadata,'locally-queued');
 const next=open(process.execPath,s.m.paths.stateRoot);t.after(next.close);await next.initialize();
 assert.equal(output('applyChange',await next.call('applyChange',request)).run.runId,run.runId);assert.deepEqual(s.metadataPatches,[{reportStatus:false}]);
 const after=output('accountState',await next.call('accountState',{section:'machine'}));
 assert.equal(after.items[0].persistence,'locally-queued');assert.equal(after.items[0].effective.reportStatus,false);assert.equal(after.items[0].confirmed.reportStatus,true);
 assert.doesNotMatch(JSON.stringify(after),/token|credential|signInFlow/);
});

test('MCP sync remains strict when an independent integrations manifest is invalid', async t => {
  const s = await agent('app', { integrationsJson: '{invalid' }); t.after(s.close);
  const client = open(process.execPath, s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  const before = s.m.read(join(s.m.paths.stateRoot, 'decisions.json'));
  const incoming = await client.call('incomingChanges', { setupId: 'local' });
  assert.equal(incoming.result.isError, true, JSON.stringify(incoming));
  const preview = await client.call('previewChange', { change: { kind: 'syncDecision', setupId: 'local', revision: { kind: 'local', commit: 'b'.repeat(40) }, itemId: EFFORT, action: 'hold' } });
  assert.equal(preview.result.isError, true, JSON.stringify(preview));
  assert.equal(s.m.read(join(s.m.paths.stateRoot, 'decisions.json')), before);
  assert.equal(s.m.read(join(s.m.paths.stateRoot, 'sync.json')), undefined);
  assert.deepEqual(output('listRuns', await client.call('listRuns', { limit: 10 })).runs, []);
});

test('MCP lists and deletes corrupt author drafts through the shared durable workflow', async t => {
  const s = await agent(); t.after(s.close);
  const id = '00000000-0000-4000-8000-000000000003';
  s.m.write(join(s.m.paths.stateRoot, 'agent/author/drafts', id + '.json'), '{');
  const client = open(process.execPath, s.m.paths.stateRoot); t.after(client.close); await client.initialize();
  const drafts = output('drafts', await client.call('drafts'));
  assert.equal(drafts.drafts[0].id, id); assert.equal(typeof drafts.drafts[0].error, 'string');
  const preview = output('previewChange', await client.call('previewChange', { change: { kind: 'deleteDraft', draftId: id } }));
  const accepted = output('applyChange', await client.call('applyChange', { planId: preview.planId, requestId: 'delete-author-draft' }));
  let run = accepted.run;
  for (let attempt = 0; attempt < 200 && !run.result; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    run = output('getRun', await client.call('getRun', { runId: run.runId }));
  }
  assert.equal(run.state, 'succeeded'); assert.deepEqual(output('drafts', await client.call('drafts')), { drafts: [] });
  assert.equal((await client.call('discoverUpstream', { source: 'https://user:secret@github.com/owner/repo' })).result.isError, true);
});
