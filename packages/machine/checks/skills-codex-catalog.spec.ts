import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Effect, Layer } from 'effect';
import { machinePaths, nodeFs } from '../src/index.ts';
import { ProcessDialogue, nodeProcessDialogue } from '../src/process-dialogue.ts';
import { verifyCodexSkill } from '../src/skills/codex-catalog.ts';

const posixTest = process.platform === 'win32' ? test.skip : test;

const fixture=(t:TestContext, mode='enabled')=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'codex-catalog-')));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const codex=join(home,'codex'),cwd=join(home,'neutral'),skillPath=join(home,'skill','SKILL.md');
  mkdirSync(codex);mkdirSync(cwd);mkdirSync(join(home,'skill'));writeFileSync(skillPath,'fixture');
  const paths={repo:home,claude:home,codex,codexOpenRouter:home,agentsSkills:home,stateRoot:home,backups:home};
  const script=`const assert=require('node:assert/strict'); let stage=0;const send=x=>{if(${JSON.stringify(mode)}==='ambiguous'&&x.result?.data)x.result.data[0].skills.push({...x.result.data[0].skills[0]});if(${JSON.stringify(mode)}==='wrong-response-id'&&x.id===2)x.id=99;console.log(JSON.stringify(x));};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);
if(stage===0){assert.equal(x.method,'initialize');assert.equal(process.env.HOME,${JSON.stringify(home)});assert.equal(process.env.CODEX_HOME,${JSON.stringify(codex)});stage++;send({id:x.id,result:{codexHome:${mode==='missing-home'?'undefined':JSON.stringify(mode==='wrong-home'?home:codex)},future:true}});}
else if(stage===1){assert.equal(x.method,'initialized');stage++;}
else{assert.equal(stage,2);stage++;assert.equal(x.method,'skills/list');assert.deepEqual(x.params,{cwds:[${JSON.stringify(cwd)}],forceReload:true});
${mode==='unsupported' ? `send({id:x.id,error:{code:-32601,message:'secret'}});` : mode==='server-request' ? `send({id:99,method:'tool/run',params:{}});` : mode==='malformed' ? `send({id:x.id,result:{data:[{cwd:${JSON.stringify(cwd)},skills:[]}]}});` : `send({method:'future/notification',params:{}});send({id:x.id,result:{future:42,data:[{cwd:${JSON.stringify(mode==='wrong-cwd'?home:cwd)},skills:[{name:'untrusted',path:${JSON.stringify(mode==='wrong-path'?join(home,'other','SKILL.md'):skillPath)},enabled:${mode==='disabled'?'false':mode==='missing-enabled'?'undefined':'true'},future:'accepted'}],errors:${mode==='discovery-errors'?'[{path:"secret",message:"secret"}]':'[]'}}]}});`}}
});`;
  const local=Layer.effect(ProcessDialogue,ProcessDialogue.use(p=>Effect.succeed({exchange:(request:Parameters<typeof p.exchange>[0])=>{
    assert.deepEqual(request.command.args,['app-server','--listen','stdio://']);assert.equal(request.command.cmd,'codex');
    return p.exchange({...request,command:{...request.command,cmd:process.execPath,args:['-e',script]}});
  }}))).pipe(Layer.provide(nodeProcessDialogue({env:{HOME:home}})));
  return {skillPath,cwd,home,run:(path=skillPath)=>Effect.runPromise(verifyCodexSkill({skillPath:path,cwd}).pipe(Effect.provide(Layer.mergeAll(nodeFs,machinePaths(paths),local))))};
};

posixTest('Codex verifies native enabled canonical path with forward fields and no model/config requests',async t=>{
  const f=fixture(t);assert.deepEqual(await f.run(),{verified:true,path:f.skillPath,enabled:true});
});
posixTest('Codex accepts canonical identity through an installed path symlink',async t=>{
  const f=fixture(t);const alias=join(f.home,'alias');symlinkSync(join(f.home,'skill'),alias);assert.deepEqual(await f.run(join(alias,'SKILL.md')),{verified:true,path:f.skillPath,enabled:true});
});
for(const [mode,reason] of [['disabled','disabled'],['ambiguous','ambiguous'],['wrong-response-id','invalid-response'],['missing-home','invalid-response'],['wrong-home','wrong-home'],['wrong-cwd','invalid-catalog'],['wrong-path','not-found'],['missing-enabled','invalid-catalog'],['discovery-errors','discovery-errors'],['unsupported','unsupported'],['server-request','unexpected-request'],['malformed','invalid-catalog']] as const)
  posixTest(`Codex leaves ${mode} unverified`,async t=>{const result=await fixture(t,mode).run();assert.deepEqual(result,{verified:false,reason});});

test('Codex remains unverified on Windows even when the accepted skill exists', async t => {
  const f = fixture(t);
  const childProcess = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let launches = 0;
  t.mock.method(childProcess.default, 'spawn', () => { launches++; throw new Error('must not launch'); });
  syncBuiltinESMExports();
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    assert.deepEqual(await f.run(), { verified: false, reason: 'unsupported-platform' });
    assert.equal(launches, 0);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
