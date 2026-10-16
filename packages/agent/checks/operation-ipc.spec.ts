import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { Deferred, Effect, Exit, Scope } from 'effect';
import { configDomain, DecisionsStore, HistoryStore, integrationsDomain } from '@nortuscc/machine';
import {
  AgentStateStore, makeSession, MAX_RECORD_BYTES, serveIpc, startAgent,
  type AgentDomain, type AgentDomains,
} from '../src/index.ts';
import { pause, resume } from '../src/pause.ts';
import { agentMachine } from './support/agent-machine.ts';
import { accept, EFFORT, setupFixture } from './support/setup-fixture.ts';

const MODEL = 'setting:claude:settings.json#model';

type Wire = { readonly [key: string]: any };

// One client connection: every record it received, in order.
type Client = {
  readonly socket: Socket;
  readonly records: Array<Wire>;
  readonly send: (record: unknown) => void;
  readonly sendRaw: (text: string) => void;
  // The first record from index `from` on that matches.
  readonly waitFor: (match: (record: Wire) => boolean, from?: number) => Promise<Wire>;
  readonly closed: Promise<void>;
};

const connect = (path: string) =>
  new Promise<Client>((resolve, reject) => {
    const socket = createConnection(path);
    const records: Array<Wire> = [];
    let pending = '';
    let notify = () => {};
    let ended = false;
    const closed = new Promise<void>((done) => socket.once('close', () => {
      ended = true;
      notify();
      done();
    }));
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        records.push(JSON.parse(pending.slice(0, newline)));
        pending = pending.slice(newline + 1);
      }
      notify();
    });
    const waitFor = (match: (record: Wire) => boolean, from = 0) =>
      new Promise<Wire>((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`no matching record; got ${JSON.stringify(records.slice(from))}`)), 20_000);
        const check = () => {
          const found = records.slice(from).find(match);
          if (found) {
            clearTimeout(timer);
            done(found);
          } else if (ended) {
            clearTimeout(timer);
            fail(new Error(`closed without a matching record; got ${JSON.stringify(records.slice(from))}`));
          } else notify = check;
        };
        check();
      });
    socket.once('connect', () => resolve({
      socket, records, waitFor, closed,
      send: (record) => socket.write(JSON.stringify(record) + '\n'),
      sendRaw: (text) => socket.write(text),
    }));
    socket.once('error', reject);
  });

let ids = 0;
// Sends `command` and answers its response.
const ask = async (client: Client, command: object) => {
  const id = `r${++ids}`;
  const from = client.records.length;
  client.send({ version: 3, id, ...command });
  return client.waitFor((r) => r.id === id, from);
};

type Options = {
  readonly config?: AgentDomain;
  readonly identity?: 'app' | 'cli' | 'stale';
};

// A trusted machine whose head adds two accepted settings keys, as in the session spec, under a
// short temp root for its socket.
const prepare = async (options: Options = {}) => {
  const m = agentMachine('/tmp');
  const fixture = setupFixture(join(m.root, 'setup'), {
    headFiles: { 'claude/settings.keys.json': JSON.stringify({ theme: 'dark', effortLevel: 'high', model: 'opus' }) + '\n' },
  });
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'dark' }) + '\n');
  await m.trust();
  await m.run(AgentStateStore.use(s => s.update(state => ({ ...state, installedBy: options.identity === 'cli' ? 'cli' : 'app', agentVersion: options.identity === 'stale' ? 'old' : '9.9.9', appPath: '/tmp/Test.app/Contents/MacOS/Test' }))));
  for (const itemId of [EFFORT, MODEL]) await m.run(DecisionsStore.use((d) => d.record(accept(itemId))));
  const domains: AgentDomains = (paths) => [options.config ?? configDomain, integrationsDomain({ paths, env: {} })];
  const source = fixture.source;
  const dir = join(m.paths.stateRoot, 'agent');
  m.write(join(dir, 'runtime.json'), JSON.stringify({agentVersion:'9.9.9',appVersion:'0.1.6',target:'darwin-arm64'}));
  return { m, fixture, domains, source, dir, socketPath: join(dir, 'agent.sock'), tokenPath: join(dir, 'agent.token') };
};

// `prepare`'s machine served on its socket. `open` connects and says hello. The agent, the session
// and the server run in a scope the test closes after the start job has finished.
const serverMachine = async (options: Options = {}) => {
  const { m, domains, source, dir, socketPath, tokenPath } = await prepare(options);
  const scope = Scope.makeUnsafe();
  await m.run(Effect.gen(function* () {
    const agent = yield* startAgent(domains);
    const session = yield* makeSession(agent, { signal: new AbortController().signal, domains });
    yield* serveIpc({
      paths: m.paths, handle: agent, session, agentVersion: '9.9.9', appRuntime: { version: '0.1.6', runtimeId: '9.9.9', appDirectory: '/tmp/Test.app/Contents/MacOS', platform: 'darwin', target: 'darwin-arm64', metadataPath: join(dir,'runtime.json') }, onShutdown: () => {},
    });
    while ((yield* agent.status) === undefined) yield* Effect.sleep('10 millis');
  }).pipe(Scope.provide(scope)), source);
  const token = readFileSync(tokenPath, 'utf8');
  const clients: Array<Client> = [];
  const open = async (client: 'app' | 'cli' | 'mcp' = 'mcp') => {
    const c = await connect(socketPath);
    clients.push(c);
    const hello = await ask(c, { command: 'hello', token, client, ...(client === 'mcp' ? { runtimeId: '9.9.9' } : {}) });
    assert.equal(hello.ok, true, JSON.stringify(hello));
    return c;
  };
  const close = async () => {
    for (const c of clients) c.socket.destroy();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(m.root, {recursive:true,force:true});
  };
  return { m, dir, socketPath, tokenPath, token, open, clients, close };
};

const withServer = async (options: Options, body: (s: Awaited<ReturnType<typeof serverMachine>>) => Promise<void>) => {
  const s = await serverMachine(options);
  try {
    await body(s);
  } finally {
    await s.close();
  }
};


const operation = (c: Client, name: string, input: object = {}) => ask(c, { command: 'operation', operation: name, input });
const KEY = 'config:claude:settings.json#effortLevel';
test('authenticated MCP operations are strict, machine-scoped, reconnectable and attributed', async () => {
  await withServer({}, async s => {
    const c = await s.open();
    const context = await operation(c, 'getContext');
    assert.equal(context.ok, true, JSON.stringify(context));
    assert.equal(context.result.app.ownership, 'app');
    assert.equal(context.result.capabilities.applyChange.available, true);
    assert.equal((await operation(c, 'inspect')).ok, true);
    assert.equal((await operation(c, 'previewChange', { change: { kind: 'reconcile', only: [KEY] }, extra: true })).error.code, 'INVALID_REQUEST');
    assert.equal((await operation(c, 'previewChange', { scope: { kind: 'user' }, change: { kind: 'reconcile', only: [KEY] } })).error.code, 'UNSUPPORTED_SCOPE');
    for (const command of ['shutdown', 'trustSetup', 'apply', 'decide', 'setPolicy', 'resume']) {
      const args = command === 'trustSetup' ? {setupId:'some-id'} : command === 'apply' ? {planId:'fake'} : command === 'decide' ? {items:[]} : command === 'setPolicy' ? {policy:'manual'} : {};
      assert.equal((await ask(c, { command, ...args })).error.code, 'UNAUTHORIZED');
    }
    const from = c.records.length;
    c.sendRaw('x'.repeat(MAX_RECORD_BYTES + 10) + '\n');
    assert.equal((await c.waitFor(r => !r.ok, from)).error.code, 'OVERSIZED');
    const preview = await operation(c, 'previewChange', { change: { kind: 'reconcile', only: [KEY] } });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const ui = await s.open('app'); await ask(ui, {command:'subscribe'});
    const applied = await operation(c, 'applyChange', {planId:preview.result.planId, requestId:'socket-intent'});
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.result.status, 'started');
    const runId = applied.result.run.runId; c.socket.destroy();
    await ui.waitFor(r => r.event === 'progress' && r.runId === runId && r.progress.type === 'done');
    const reconnected = await s.open();
    const run = await operation(reconnected, 'getRun', {runId});
    assert.equal(run.result.state, 'succeeded');
    assert.equal((await operation(reconnected, 'applyChange', {planId:preview.result.planId, requestId:'socket-intent'})).result.run.runId, runId);
    assert.equal((await operation(reconnected, 'listRuns', {limit:10})).result.runs.length, 1);
    assert.equal((await operation(reconnected, 'cancelRun', {runId})).result.state, 'succeeded');
    const history = await operation(reconnected, 'history', {limit:500});
    assert.ok(history.result.events.some((e: Wire) => e.actor === 'mcp' && e.requestId === 'socket-intent' && e.runId === runId));
  });
});

test('CLI-owned and stale agents refuse MCP operations while exposing actionable context', async () => {
  for (const identity of ['cli','stale'] as const) await withServer({identity}, async s => {
    const c = await s.open();
    const context = await operation(c, 'getContext');
    assert.equal(context.result.capabilities.applyChange.available, false);
    assert.ok(context.result.diagnostics.length > 0);
    assert.equal((await operation(c, 'inspect')).error.code, 'APP_UNAVAILABLE');
    assert.deepEqual(JSON.parse(readFileSync(join(s.m.paths.claude,'settings.json'),'utf8')), {theme:'dark'});
  });
});

test('maintenance activated after preview refuses acceptance without a run or mutation', async () => {
  await withServer({}, async s => {
    const c = await s.open(); await operation(c, 'inspect');
    const preview = await operation(c, 'previewChange', {change:{kind:'reconcile',only:[KEY]}});
    s.m.write(join(s.m.paths.stateRoot,'agent/pending-update.json'), '{}');
    const result = await operation(c, 'applyChange', {planId:preview.result.planId,requestId:'fenced'});
    assert.equal(result.error.code, 'LOCKED');
    assert.equal((await operation(c, 'getContext')).result.capabilities.applyChange.available, false);
    assert.equal((await operation(c, 'cancelRun', {runId:'unaccepted'})).error.code,'LOCKED');
    assert.equal((await operation(c, 'listRuns', {limit:10})).result.runs.length,0);
    assert.deepEqual(JSON.parse(readFileSync(join(s.m.paths.claude,'settings.json'),'utf8')), {theme:'dark'});
  });
});

test('MCP authentication reads a fresh token and rejects incorrect runtime identity without mutation', async () => {
  await withServer({}, async s => {
    const unauthenticated = await connect(s.socketPath);
    assert.equal((await operation(unauthenticated, 'inspect')).error.code, 'UNAUTHORIZED'); await unauthenticated.closed;
    const unauthenticatedBackups = await connect(s.socketPath);
    assert.equal((await operation(unauthenticatedBackups, 'listBackups', {limit:1})).error.code, 'UNAUTHORIZED'); await unauthenticatedBackups.closed;
    const bad = await connect(s.socketPath);
    assert.equal((await ask(bad, {command:'hello',client:'mcp',runtimeId:'9.9.9',token:'wrong'})).error.code, 'UNAUTHORIZED'); await bad.closed;
    const mismatch = await connect(s.socketPath); s.clients.push(mismatch);
    const hello = await ask(mismatch, {command:'hello',client:'mcp',runtimeId:'old',token:readFileSync(s.tokenPath,'utf8')});
    assert.equal(hello.result.operations.available,false);
    assert.equal((await operation(mismatch,'getContext')).result.capabilities.applyChange.available,false);
    assert.equal((await operation(mismatch,'inspect')).error.code,'APP_UNAVAILABLE');
    const good = await s.open();
    s.m.write(join(s.dir,'runtime.json'), JSON.stringify({agentVersion:'updated',appVersion:'0.1.7',target:'darwin-arm64'}));
    assert.equal((await operation(good,'inspect')).error.code,'APP_UNAVAILABLE');
  });
});

test('all shared operations refuse unsupported scopes and nested unknown fields', async () => {
  await withServer({}, async s => {
    const c = await s.open();
    const requests = { listBackups:{limit:1},getContext:{},inspect:{},previewChange:{change:{kind:'reconcile',only:[]}},applyChange:{planId:'p',requestId:'i'},getRun:{runId:'r'},listRuns:{limit:10},cancelRun:{runId:'r'},history:{limit:10} };
    for (const [name,args] of Object.entries(requests)) {
      for (const scope of [{kind:'user'},{kind:'profile',profileId:'p'}]) assert.equal((await operation(c,name,{...args,scope})).error.code,'UNSUPPORTED_SCOPE');
      assert.equal((await operation(c,name,{...args,scope:{kind:'machine',path:'/tmp'}})).error.code,'INVALID_REQUEST');
    }
    assert.equal((await operation(c,'listRuns',{limit:501})).error.code,'INVALID_REQUEST');
    assert.equal((await operation(c,'previewChange',{change:{kind:'reconcile',only:['k'.repeat(501)]}})).error.code,'INVALID_REQUEST');
    assert.equal((await operation(c,'previewChange',{change:{kind:'reconcile',only:[],force:'true'}})).error.code,'INVALID_REQUEST');
    assert.deepEqual(JSON.parse(readFileSync(join(s.m.paths.claude,'settings.json'),'utf8')), {theme:'dark'});
  });
});

test('a changed fresh plan returns a stale preview without accepting a receipt or changing the machine', async () => {
  let summary = 'before';
  const config: AgentDomain = {...configDomain,steps:(...args) => { const p = configDomain.steps(...args); return {...p,steps:p.steps.map(step => ({...step,summary}))}; }};
  await withServer({config}, async s => {
    const c = await s.open(); await operation(c,'inspect');
    const preview = await operation(c,'previewChange',{change:{kind:'reconcile',only:[KEY]}});
    summary = 'after';
    const applied = await operation(c,'applyChange',{planId:preview.result.planId,requestId:'stale-intent'});
    assert.equal(applied.result.status,'stale'); assert.notEqual(applied.result.preview.planId,preview.result.planId);
    assert.deepEqual(applied.result.preview.change,preview.result.change);
    assert.equal((await operation(c,'listRuns',{limit:10})).result.runs.length,0);
    assert.deepEqual(JSON.parse(readFileSync(join(s.m.paths.claude,'settings.json'),'utf8')), {theme:'dark'});
  });
});

test('concurrent app and MCP acceptance share the same apply coordination and lock', async () => {
  const started = Deferred.makeUnsafe<void>(); const release = Deferred.makeUnsafe<void>(); let calls = 0;
  const config: AgentDomain = {...configDomain,run:(step,report) => Effect.gen(function* () { calls++; yield* Deferred.succeed(started,undefined); yield* Deferred.await(release); return yield* configDomain.run(step,report); })};
  await withServer({config},async s => {
    const mcp=await s.open(); const app=await s.open('app'); await operation(mcp,'inspect');
    const preview=await operation(mcp,'previewChange',{change:{kind:'reconcile',only:[KEY]}});
    const accepted=await operation(mcp,'applyChange',{planId:preview.result.planId,requestId:'concurrent'});
    await Effect.runPromise(Deferred.await(started));
    try {
      assert.equal((await ask(app,{command:'apply',planId:preview.result.planId})).error.code,'BUSY');
      assert.equal((await operation(mcp,'applyChange',{planId:preview.result.planId,requestId:'competing'})).error.code,'BUSY');
      assert.equal((await ask(app,{command:'status'})).result.applying,true); assert.equal(calls,1);
    } finally { Deferred.doneUnsafe(release,Effect.void); }
    let run=await operation(mcp,'getRun',{runId:accepted.result.run.runId});
    while(run.result.result===null) { await new Promise(resolve=>setTimeout(resolve,1)); run=await operation(mcp,'getRun',{runId:accepted.result.run.runId}); }
    assert.equal(run.result.state,'succeeded'); assert.equal(calls,1);
  });
});

test('authenticated shared History replaces private failed-step and pause diagnostics with closed summaries', async () => {
  await withServer({}, async s => {
    const diagnostic = 'Failed to parse private input: password=fixture-only-value';
    await s.m.run(HistoryStore.use(history => history.append({kind:'apply-finished',actor:'agent',runId:'private-diagnostic',backup:null,result:'done',
      steps:[{key:'config:one',outcome:'failed',note:diagnostic},{key:'config:two',outcome:'ok',note:diagnostic},{key:'config:three',outcome:'cancelled',note:diagnostic}],
    })));
    await s.m.run(Effect.andThen(pause(diagnostic), resume('app')));
    const stored = await s.m.events();
    assert.ok(JSON.stringify(stored).includes(diagnostic));
    const c = await s.open();
    const reply = await operation(c,'history',{limit:100});assert.equal(reply.ok,true);
    assert.doesNotMatch(JSON.stringify(reply.result),/fixture-only-value|password=|Failed to parse private input/);
    assert.deepEqual(reply.result.events.find((e:Wire)=>e.runId==='private-diagnostic').steps,[
      {key:'config:one',outcome:'failed',note:'Step failed'},
      {key:'config:two',outcome:'ok',note:'Step completed'},
      {key:'config:three',outcome:'cancelled',note:'Step cancelled'},
    ]);
    assert.deepEqual(reply.result.events.filter((e:Wire)=>e.kind==='paused'||e.kind==='resumed').map((e:Wire)=>e.detail.reason),
      ['Application pause cleared','Automatic application paused']);
  });
});

test('authenticated shared History skips raw malformed timestamps and preserves duplicate same-time occurrences', async () => {
  await withServer({}, async s => {
    const at='2099-10-15T00:00:00.000Z';
    const policy={kind:'policy-changed',from:'manual',to:'notify',origin:'local'};
    const malformed=[{toString:0},[at],null,0,'2099-02-30T00:00:00Z','2099-10-15T25:00:00Z',' '+at,at+'\n'];
    s.m.write(join(s.m.paths.stateRoot,'history','2099-10.jsonl'),[
      {kind:'future-first',at:'2099-10-14T00:00:00.000Z'},
      ...malformed.map(value=>({kind:'future-invalid',at:value})),
      {kind:'future-duplicate-one',at,private:'fixture-only-value'},
      {...policy,at},
      {kind:'future-duplicate-two',at,private:'another-fixture-only-value'},
      {kind:'future-last',at:'2099-10-16T00:00:00.000Z'},
    ].map(event=>JSON.stringify({v:1,actor:'cli',...event})).join('\n')+'\n');
    assert.equal((await s.m.events()).filter(e=>e.kind.startsWith('future')).length,12);
    const c=await s.open();const events:Wire[]=[];const cursors:Wire[]=[];let before;
    for(let i=0;i<5;i++){
      const reply=await operation(c,'history',{limit:1,...(before?{before}:{})});
      assert.equal(reply.ok,true,JSON.stringify(reply));events.push(...reply.result.events);before=reply.result.nextBefore;cursors.push(before);
    }
    assert.deepEqual(events.map(e=>e.kind),['unknown','unknown','policy-changed','unknown','unknown']);
    assert.deepEqual(cursors.slice(1,4).map(c=>c.seq),[2,1,0]);
    assert.deepEqual(events[1],events[3]);
    assert.deepEqual(events.map(e=>e.at),['2099-10-16T00:00:00.000Z',at,at,at,'2099-10-14T00:00:00.000Z']);
    assert.doesNotMatch(JSON.stringify(events),/fixture-only-value|future-invalid/);
  });
});

test('app subscribers discover semantic receipts while legacy subscribers retain only compatible progress', async () => {
 await withServer({}, async s => {
  const app = await s.open('app'); assert.equal((await ask(app,{command:'subscribe',operationsProtocol:1})).ok,true);
  const legacy = await s.open('app'); await ask(legacy,{command:'subscribe'});
  const cli = await s.open('cli'); await ask(cli,{command:'subscribe'});
  const mcp = await s.open();
  const preview=await operation(mcp,'previewChange',{change:{kind:'setPolicy',policy:'manual'}});
  assert.equal(preview.ok,true,JSON.stringify(preview));
  const accepted=await operation(mcp,'applyChange',{planId:preview.result.planId,requestId:'semantic-discovery'});
  assert.equal(accepted.ok,true,JSON.stringify(accepted));
  const id=accepted.result.run.runId;
  const notification=await app.waitFor(r=>r.event==='operation-run'&&r.runId===id);
  assert.deepEqual(notification,{version:3,event:'operation-run',runId:id});
  await app.waitFor(r=>r.event==='progress'&&r.runId===id&&r.progress.type==='done');
  const receipt=await operation(app,'getRun',{runId:id}); assert.equal(receipt.result.state,'succeeded');
  assert.equal(receipt.result.intent.change.kind,'setPolicy');
  assert.equal(cli.records.some(r=>r.event==='operation-run'),false);
  assert.equal(legacy.records.some(r=>r.event==='operation-run'),false);
  assert.equal(app.records.some(r=>r.event==='progress'&&r.progress.type==='started'),false);
  assert.equal(mcp.records.some(r=>r.event==='operation-run'),false);
  assert.ok(app.records.filter(r=>r.event==='operation-run').length>=2);
 });
});

test('every finished run is followed by a status event that is no longer applying', async () => {
  await withServer({}, async s => {
    const app = await s.open('app'); assert.equal((await ask(app, { command: 'subscribe', operationsProtocol: 1 })).ok, true);
    const mcp = await s.open();
    // Backup retention has no follow-up job, so only the run's own end can bring the status up to date.
    const preview = await operation(mcp, 'previewChange', { change: { kind: 'pruneBackups' } });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const accepted = await operation(mcp, 'applyChange', { planId: preview.result.planId, requestId: 'status-after-run' });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const id = accepted.result.run.runId;
    const done = await app.waitFor(r => r.event === 'progress' && r.runId === id && r.progress.type === 'done');
    const status = await app.waitFor(r => r.event === 'status', app.records.indexOf(done) + 1);
    assert.equal(status.status.applying, false);
  });
});
