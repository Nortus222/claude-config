import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Actor, HistoryEvent } from '@nortuscc/machine';
import { interruptedRun, pause, resume } from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';

const started = (runId: string, actor: Actor = 'agent', automatic = true): HistoryEvent =>
  ({ v: 1, at: '2026-10-06T12:00:00.000Z', kind: 'apply-started', actor, runId, automatic, keys: [] });
const finished = (runId: string): HistoryEvent =>
  ({ v: 1, at: '2026-10-06T12:00:01.000Z', kind: 'apply-finished', actor: 'agent', runId, steps: [], backup: null, result: 'done' });
const paused = (runId: string): HistoryEvent =>
  ({ v: 1, at: '2026-10-06T12:00:02.000Z', kind: 'paused', actor: 'agent', reason: 'interrupted', runId });

test('interruptedRun finds an automatic run that started and never finished', () => {
  assert.equal(interruptedRun([started('a'), finished('a'), started('b')]), 'b');
  assert.equal(interruptedRun([started('a'), finished('a')]), undefined);
  assert.equal(interruptedRun([]), undefined);
});

test('interruptedRun ignores a run a pause already names, so a crash loop pauses once', () => {
  assert.equal(interruptedRun([started('a'), paused('a')]), undefined);
});

test('interruptedRun ignores runs the agent did not start automatically', () => {
  assert.equal(interruptedRun([started('a', 'cli', false)]), undefined);
  assert.equal(interruptedRun([started('a', 'agent', false)]), undefined);
});

test('pause records why; resume clears it once', async () => {
  const m = agentMachine();
  await m.run(pause('1 step(s) failed', 'run-1'));
  const state = m.agentJson();
  assert.equal(state.paused.reason, '1 step(s) failed');
  assert.equal(state.paused.runId, 'run-1');
  assert.ok(!Number.isNaN(Date.parse(state.paused.at)));
  assert.equal(await m.run(resume('cli')), true);
  assert.equal(m.agentJson().paused, null);
  assert.equal(await m.run(resume('cli')), false);
  const events = await m.events();
  assert.deepEqual(events.map((e) => e.kind), ['paused', 'resumed']);
  assert.ok(events[0]?.kind === 'paused');
  assert.equal(events[0].runId, 'run-1');
  assert.equal(events[1]?.actor, 'cli');
});
