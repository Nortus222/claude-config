import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as protocol from '../src/ipc/protocol.ts';

test('strict hosted commands accept opaque numeric choices and refuse identity injection', () => {
  const request = { version: 3, id: '1', command: 'decide', items: [{ setupId: 'setup1', id: 'integration:hook', revision: 2, decision: 'accept' }] };
  assert.doesNotThrow(() => protocol.decodeRequest(request));
  for (const change of [{ revision: 'a'.repeat(40) }, { setupId: 'local' }, { id: '../private' }, { token: 'secret' }, { revision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => protocol.decodeRequest({ ...request, items: [{ ...request.items[0], ...change }] }));
  }
  for (const command of ['hostedState', 'signOut', 'syncNow']) assert.doesNotThrow(() => protocol.decodeRequest({ version: 3, id: '1', command }));
  assert.doesNotThrow(() => protocol.decodeRequest({ version: 3, id: '1', command: 'signIn', name: 'My machine' }));
  assert.doesNotThrow(() => protocol.decodeRequest({ version: 3, id: '1', command: 'trustSetup', setupId: 'setup1' }));
  assert.throws(() => protocol.decodeRequest({ version: 3, id: '1', command: 'trustSetup', setupId: 'setup1', accountId: 'other' }));
  assert.throws(() => protocol.decodeRequest({ version: 3, id: '1', command: 'machineSettings', patch: { reportStatus: false, token: 'secret' } }));
});

test('safe hosted results reject pending credentials and unknown nested metadata', () => {
  assert.equal(typeof protocol.decodeSignInResult, 'function');
  const start = { userCode: 'ABCD', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 120 };
  assert.deepEqual(protocol.decodeSignInResult(start), start);
  assert.throws(() => protocol.decodeSignInResult({ ...start, pendingId: 'private' }));
});

test('reporting choice exists only on strict local sign-in requests', () => {
  for (const reportStatus of [true, false]) assert.deepEqual(protocol.decodeRequest({ version: 3, id: '1', command: 'signIn', reportStatus }), { version: 3, id: '1', command: 'signIn', reportStatus });
  for (const reportStatus of [null, 'false', 0, {}]) assert.throws(() => protocol.decodeRequest({ version: 3, id: '1', command: 'signIn', reportStatus }));
  assert.throws(() => protocol.decodeRequest({ version: 3, id: '1', command: 'signIn', reportStatus: false, token: 'secret' }));
});

test('legacy hosted projection omits internal pending and confirmed metadata fields', () => {
  const value={enabled:true,recovered:true,signingIn:false,accountId:null,login:null,machineId:null,auth:'signed-out',setups:[],machine:null,lastSyncAt:null,retryAt:null,pollAfter:900,error:null};
  assert.deepEqual(protocol.toWireHostedState({...value,pendingMachinePatches:[{name:'PRIVATE'}],confirmedMachine:null,machinePersistence:'confirmed'}),value);
  assert.throws(()=>protocol.decodeHostedState({...value,pendingMachinePatches:[]}));
});
