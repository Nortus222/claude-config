import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupDiagnostics, STARTUP_PREFIX, type StartupPhase } from '../agent/startup-diagnostics.ts';

test('startup records identify a run and measure phase duration with monotonic time', () => {
  let monotonic = 10;
  let wall = 1000;
  const lines: string[] = [];
  const trace = startupDiagnostics({ component: 'helper', operation: 'ensure', write: line => lines.push(line),
    clock: { monotonic: () => monotonic, wall: () => wall } });
  trace.record('login_probe', 'started');
  monotonic = 85;
  wall = 1;
  trace.record('login_probe', 'fallback');
  const records = lines.map(line => JSON.parse(line.slice(STARTUP_PREFIX.length)));
  assert.equal(records.length, 2, 'start and terminal timings must be observable');
  assert.equal(records[0].startedAt, 1000);
  assert.equal(records[1].startedAt, 1000, 'wall-clock adjustment cannot change a run identity');
  assert.equal(records[1].elapsedMs, 75);
  assert.equal(records[1].durationMs, 75);
  assert.equal(records[1].pid, process.pid);
  assert.deepEqual(records.map(r => [r.seq, r.phase, r.status]), [[1, 'login_probe', 'started'], [2, 'login_probe', 'fallback']]);
  assert.ok(lines.every(line => line.endsWith('\n') && line.length < 2048));
});

test('diagnostic records reject arbitrary text and broken clocks or sinks stay harmless', () => {
  const lines: string[] = [];
  const trace = startupDiagnostics({ component: 'agent', operation: 'foreground', write: line => lines.push(line) });
  trace.record('secret-token-value' as StartupPhase, 'failed');
  assert.equal(lines.length, 0);
  const brokenSink = startupDiagnostics({ component: 'helper', operation: 'paths', write: () => { throw new Error('credential-text'); } });
  assert.doesNotThrow(() => brokenSink.record('entry', 'started'));
  const brokenClock = startupDiagnostics({ component: 'helper', operation: 'paths', write: line => lines.push(line),
    clock: { monotonic: () => { throw new Error('clock unavailable'); }, wall: () => Infinity } });
  assert.doesNotThrow(() => brokenClock.record('entry', 'started'));
  assert.equal(lines.length, 0);
});

test('first job records retain the fixed phase, terminal outcome and measured duration', () => {
  let now = 0;
  const lines: string[] = [];
  const trace = startupDiagnostics({ component: 'agent', operation: 'foreground', write: line => lines.push(line),
    clock: { monotonic: () => now, wall: () => 1000 } });
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    trace.record('first_job', 'started');
    now += 25;
    trace.record('first_job', status);
  }
  const records = lines.map(line => JSON.parse(line.slice(STARTUP_PREFIX.length)));
  assert.equal(records.length, 6);
  assert.ok(records.every(record => record.phase === 'first_job'));
  assert.deepEqual(records.filter(record => record.status !== 'started').map(record => [record.status, record.durationMs]),
    [['completed', 25], ['failed', 25], ['cancelled', 25]]);
});
