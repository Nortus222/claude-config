import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Cause, Effect, Exit, Fiber } from 'effect';
import { ProcessDialogue, nodeProcessDialogue, type DialogueExchange } from '../src/process-dialogue.ts';

const posixTest = process.platform === 'win32' ? test.skip : test;

const step = (id: number) => ({ send: [{ id }], receive: (value: unknown) => {
  const row = value as { id?: number; result?: unknown };
  return row.id === id ? { kind: 'accept' as const, value: row.result } : { kind: 'ignore' as const };
} });
const run = (script: string, extra: Partial<DialogueExchange> = {}) => Effect.runPromiseExit(
  ProcessDialogue.use(p => p.exchange({ command: { cmd: process.execPath, args: ['-e', script] }, steps: [step(1), step(2)], ...extra }))
    .pipe(Effect.provide(nodeProcessDialogue({ env: {} }))));
const server = (body: string) => `require('node:readline').createInterface({input:process.stdin}).on('line', line => { const row=JSON.parse(line); ${body} });`;

posixTest('dialogue waits for each response, holds stdin, and joins after EOF', async () => {
  const result = await run(`let waiting=false;` + server(`if(waiting)process.exit(9);waiting=true;setTimeout(() => {waiting=false;console.log(JSON.stringify({id:row.id,result:row.id}));}, 20);`));
  assert.ok(Exit.isSuccess(result)); assert.deepEqual(result.value, [1, 2]);
});
for (const [name, script, reason, extra] of [
  ['malformed', `console.log('secret-invalid-json');`, 'malformed-record', {}],
  ['oversized record', `process.stdout.write('x'.repeat(100));`, 'record-limit', { maxRecordBytes: 50 }],
  ['total bytes', `process.stdout.write('{}\\n'.repeat(100));`, 'output-limit', { maxTotalBytes: 50 }],
  ['stderr bytes', `process.stderr.write('s'.repeat(100));`, 'stderr-limit', { maxStderrBytes: 50 }],
  ['EOF', `process.exit(0);`, 'unexpected-eof', {}],
  ['deadline', `setInterval(() => {}, 1000);`, 'timed-out', { timeoutMs: 50 }],
  ['nonzero after reply', server(`console.log(JSON.stringify({id:row.id,result:row.id})); if(row.id===2)process.exitCode=7;`), 'exit-failed', {}],
] as const) posixTest(`dialogue rejects ${name} with bounded diagnostics`, async () => {
  const result = await run(script, extra); assert.ok(Exit.isFailure(result));
  assert.match(String(result.cause), new RegExp(reason)); assert.doesNotMatch(String(result.cause), /secret-invalid-json/);
});

posixTest('dialogue uses only supplied environment and command overrides', async () => {
  const result = await run(server(`console.log(JSON.stringify({id:row.id,result:[process.env.HOME??null,process.env.EXPLICIT]}));`),
    { command: { cmd: process.execPath, args: ['-e', server(`console.log(JSON.stringify({id:row.id,result:[process.env.HOME??null,process.env.EXPLICIT]}));`)], env: { EXPLICIT: 'yes' } } });
  assert.ok(Exit.isSuccess(result)); assert.deepEqual(result.value, [[null, 'yes'], [null, 'yes']]);
});

for (const mode of ['success', 'failure', 'cancellation'] as const) posixTest(`dialogue joins descendants on ${mode}`, { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogue-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'pid');
  const script = `const c=require('node:child_process').spawn(${JSON.stringify(process.execPath)},['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));`
    + (mode === 'success' ? server(`console.log(JSON.stringify({id:row.id,result:true}));`) : mode === 'failure' ? `console.log('invalid');setInterval(()=>{},1000);` : `setInterval(()=>{},1000);`);
  if (mode === 'cancellation') await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(ProcessDialogue.use(p => p.exchange({ command: { cmd: process.execPath, args: ['-e', script] }, steps: [step(1)] })));
    for (let n=0;n<100&&!existsSync(marker);n++) yield* Effect.sleep(10);
    assert.ok(existsSync(marker)); yield* Fiber.interrupt(fiber);
  }).pipe(Effect.provide(nodeProcessDialogue({ env: {} }))));
  else { const result=await run(script); assert.equal(Exit.isSuccess(result), mode==='success'); }
  assert.throws(() => process.kill(Number(readFileSync(marker,'utf8')),0), {code:'ESRCH'});
});

for (const mode of ['timeout', 'cancellation'] as const) posixTest(`unconfirmed cleanup survives ${mode}`, { skip: process.platform === 'win32' }, async t => {
  const kill = process.kill;
  t.mock.method(process,'kill',(pid:number, signal?:NodeJS.Signals|number) => signal===0 && pid<0 ? true : kill(pid,signal));
  if(mode==='timeout') {
    const result=await run('setInterval(()=>{},1000)',{timeoutMs:50});
    assert.ok(Exit.isFailure(result)); assert.match(String(result.cause),/cleanup-failed/);
  } else {
    const result=await Effect.runPromise(Effect.gen(function*(){
      const fiber=yield* Effect.forkChild(ProcessDialogue.use(p=>p.exchange({command:{cmd:process.execPath,args:['-e','setInterval(()=>{},1000)']},steps:[step(1)]})));
      yield* Effect.sleep(50); yield* Fiber.interrupt(fiber); return yield* Fiber.await(fiber);
    }).pipe(Effect.provide(nodeProcessDialogue({env:{}}))));
    assert.ok(Exit.isFailure(result)); assert.ok(Cause.hasInterrupts(result.cause)); assert.match(String(result.cause),/DialogueCleanupFailed/);
  }
});

posixTest('sustained stdout after record overflow still finishes cleanup', async () => {
  const result = await run(`process.on('SIGTERM',()=>{});setInterval(()=>process.stdout.write('x'.repeat(1000)),1);`, {maxRecordBytes:50});
  assert.ok(Exit.isFailure(result));assert.match(String(result.cause),/record-limit/);
});

posixTest('a held-open child that ignores TERM reaches KILL and is joined', {skip:process.platform==='win32'}, async t => {
  const dir=mkdtempSync(join(tmpdir(),'dialogue-term-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const marker=join(dir,'pid');
  const result=await run(`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,{timeoutMs:150});
  assert.ok(Exit.isFailure(result));assert.match(String(result.cause),/timed-out/);
  assert.throws(()=>process.kill(Number(readFileSync(marker,'utf8')),0),{code:'ESRCH'});
});

for(const [name,extra] of [
  ['empty sequence',{steps:[]}],['too many steps',{steps:Array.from({length:9},()=>step(1))}],
  ['too many records',{steps:[{...step(1),send:Array(9).fill({})}]}],
  ['oversized outbound',{steps:[{...step(1),send:[{x:'a'.repeat(100)}]}],maxRecordBytes:50}],
  ['invalid bounds',{timeoutMs:0}],
] satisfies Array<[string,Partial<DialogueExchange>]>) posixTest(`invalid ${name} fails before launching`,async()=>{
  const result=await run(`throw new Error('must not launch');`,extra);
  assert.ok(Exit.isFailure(result));assert.match(String(result.cause),/invalid-exchange/);
});

posixTest('missing executable fails without raw launch diagnostics',async()=>{
  const result=await run('',{command:{cmd:'/missing/secret-fixture',args:[]}});
  assert.ok(Exit.isFailure(result));assert.match(String(result.cause),/launch-failed/);assert.doesNotMatch(String(result.cause),/secret-fixture/);
});

posixTest('invalid UTF-8 inside JSON is rejected instead of replacement decoding',async()=>{
  const result=await run(`process.stdout.write(Buffer.from([34,255,34,10]));`);
  assert.ok(Exit.isFailure(result));assert.match(String(result.cause),/malformed-record/);
});

posixTest('protocol envelope correlation belongs to a finite host adapter',async()=>{
  const result=await run(server(`console.log(JSON.stringify({type:'control_response',response:{request_id:row.request_id,value:'done'}}));`),{
    steps:[{send:[{type:'control_request',request_id:'init',request:{subtype:'initialize'}}],receive:record=>{
      const row=record as {type:string;response:{request_id:string;value:string}};
      return row.type==='control_response'&&row.response.request_id==='init'?{kind:'accept',value:row.response.value}:{kind:'reject',reason:'invalid-response'};
    }}],
  });
  assert.ok(Exit.isSuccess(result));assert.deepEqual(result.value,['done']);
});

test('Windows dialogue refuses before launching because tree ownership is unavailable', async t => {
  const childProcess = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let launches = 0;
  t.mock.method(childProcess.default, 'spawn', () => { launches++; throw new Error('must not launch'); });
  syncBuiltinESMExports();
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const result = await run('process.exit(0)');
    assert.ok(Exit.isFailure(result)); assert.match(String(result.cause), /unsupported-platform/);
    assert.equal(launches, 0);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
