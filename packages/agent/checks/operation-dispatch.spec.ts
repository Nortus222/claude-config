import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Exit, Scope } from 'effect';
import { configDomain, integrationsDomain } from '@nortuscc/machine';
import { AgentStateStore, makeSession, startAgent, type AgentDomains } from '../src/index.ts';
import { makeOperationDispatch } from '../src/ipc/operation-dispatch.ts';
import { decodeOperationOutput } from '../src/operations/index.ts';
import { SessionError } from '../src/ipc/session.ts';
import { agentMachine } from './support/agent-machine.ts';
import { setupFixture } from './support/setup-fixture.ts';

const withDispatch = async (body: (run: (effect: Effect.Effect<any, any, any>) => Promise<any>, dispatch: ReturnType<typeof makeOperationDispatch>) => Promise<void>) => {
  const m = agentMachine('/tmp');
  const fixture = setupFixture(join(m.root, 'setup'), {});
  await m.trust();
  await m.run(AgentStateStore.use(s => s.update(state => ({ ...state, installedBy: 'app', agentVersion: '9.9.9', appPath: '/tmp/Test.app/Contents/MacOS/Test' }))));
  const dir = join(m.paths.stateRoot, 'agent');
  m.write(join(dir, 'runtime.json'), JSON.stringify({ agentVersion: '9.9.9', appVersion: '0.1.6', target: 'darwin-arm64' }));
  const domains: AgentDomains = (paths) => [configDomain, integrationsDomain({ paths, env: {} })];
  const scope = Scope.makeUnsafe();
  try {
    const dispatch = await m.run(Effect.gen(function* () {
      const handle = yield* startAgent(domains);
      const session = yield* makeSession(handle, { signal: new AbortController().signal, domains });
      while ((yield* handle.status) === undefined) yield* Effect.sleep('10 millis');
      return makeOperationDispatch({
        session, paths: m.paths, handle, agentVersion: '9.9.9', platform: process.platform,
        appRuntime: { version: '0.1.6', runtimeId: '9.9.9', appDirectory: '/tmp/Test.app/Contents/MacOS', platform: 'darwin', target: 'darwin-arm64', metadataPath: join(dir, 'runtime.json') },
      });
    }).pipe(Scope.provide(scope)), fixture.source);
    await body((effect) => m.run(effect, fixture.source), dispatch);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(m.root, { recursive: true, force: true });
  }
};

test('dispatch answers getContext for a machine scope and decodes it', async () => {
  await withDispatch(async (run, dispatch) => {
    const context = await run(dispatch({ actor: 'cli' }, 'getContext', { scope: { kind: 'machine' } }));
    assert.deepEqual(decodeOperationOutput('getContext', context), context);
  });
});

test('dispatch refuses user scope', async () => {
  await withDispatch(async (run, dispatch) => {
    const exit = await run(Effect.flip(dispatch({ actor: 'cli' }, 'getContext', { scope: { kind: 'user' } })));
    assert.ok(exit instanceof SessionError);
    assert.equal(exit.code, 'UNSUPPORTED_SCOPE');
  });
});

test('dispatch refuses an mcp caller whose runtime is not the app runtime', async () => {
  await withDispatch(async (run, dispatch) => {
    const error = await run(Effect.flip(dispatch({ actor: 'mcp', runtimeId: 'old' }, 'inspect', { scope: { kind: 'machine' } })));
    assert.ok(error instanceof SessionError);
    assert.equal(error.code, 'APP_UNAVAILABLE');
    const ok = await run(dispatch({ actor: 'mcp', runtimeId: '9.9.9' }, 'inspect', { scope: { kind: 'machine' } }));
    assert.ok(ok);
  });
});

test('dispatch runs a remote caller as the remote actor naming its machine', async () => {
  await withDispatch(async (run, dispatch) => {
    const caller = { actor: 'remote' as const, machine: 'Win-01', origin: 'mcp' as const };
    const input = { scope: { kind: 'machine' } };
    const inspected = await run(dispatch(caller, 'inspect', input));
    assert.ok(inspected);
    const previewed = await run(dispatch(caller, 'previewChange', { ...input, change: { kind: 'reconcile', only: [] } }));
    const started = await run(dispatch(caller, 'applyChange', { ...input, planId: previewed.planId, requestId: 'remote-request' }));
    assert.equal(started.run.actor, 'remote');
    assert.equal(started.run.remoteMachine, 'Win-01');
    assert.equal(started.run.remoteOrigin, 'mcp');
  });
});
