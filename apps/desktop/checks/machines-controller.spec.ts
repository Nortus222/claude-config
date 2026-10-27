import test from 'node:test';
import assert from 'node:assert/strict';
import type { OperationName, OperationOutput, RunView } from '@nortuscc/agent/operations';
import { MachineController } from '../src/controller.ts';
import { MachinesController, gridRows, perMachine } from '../src/machines-controller.ts';
import type { Bridge } from '../src/bridge.ts';
import { receipt, status, inspection, deferred } from './support/skills-data.ts';

type Handler = (input: Readonly<Record<string, unknown>>) => unknown;
type Skill = OperationOutput<'machineSkills'>['skills'][number];
const skill = (name: string, fields: Partial<Skill> = {}): Skill => ({ source: 'owner/skills', name, state: 'installed', choice: null, from: null, ...fields });
const access = (fields = {}): OperationOutput<'remoteAccess'> => ({ enabled: true, tailscale: 'ready', self: { name: 'mac', login: 'me@example.com' }, listening: true, ...fields });
const mine = (fields = {}): OperationOutput<'myMachines'> => ({ tailscale: 'ready', self: { nodeId: 'n-mac', name: 'mac', os: 'macOS' }, machines: [
  { nodeId: 'n-pc', name: 'pc', os: 'windows', reach: 'ok', lastReachedAt: '2026-10-26T10:00:00.000Z' },
  { nodeId: 'n-old', name: 'old', os: 'linux', reach: 'offline', lastReachedAt: '2026-10-20T10:00:00.000Z' },
], ...fields });
const started = (machine: string, runId: string) => ({ machine, name: machine, outcome: { status: 'started', runId } });

async function connected(handlers: Partial<Record<OperationName, Handler>> = {}) {
  const calls: Array<{ name: OperationName; input: Readonly<Record<string, unknown>> }> = [];
  const box = { skills: { this: [skill('tdd')], 'n-pc': [skill('tdd', { state: 'absent' })] } as Record<string, Skill[]>, run: receipt('succeeded') as RunView };
  const bridge: Bridge = {
    subscribe: async () => () => {},
    invoke: async (command, args) => {
      let data: unknown;
      if (command === 'operation') {
        const name = args!.name as OperationName, input = args!.input as Readonly<Record<string, unknown>>;
        calls.push({ name, input });
        data = await (handlers[name]?.(input) ?? (name === 'remoteAccess' ? access() : name === 'myMachines' ? mine()
          : name === 'machineSkills' ? { inspectedAt: '2026-10-26T10:00:00.000Z', skills: box.skills[input.machine as string] ?? [] }
          : name === 'applySkillOnMachines' ? { results: (input.machines as string[]).map(m => started(m, `run-${m}`)) }
          : name === 'machineRun' ? box.run : name === 'setRemoteAccess' ? access({ enabled: input.enabled }) : null));
      } else data = command === 'agent_status' ? status() : command === 'inspect_machine' ? inspection() : null;
      return { generation: 1, data };
    },
  };
  const machine = new MachineController(bridge); await machine.connect();
  const machines = new MachinesController(bridge, machine, { pollMs: 0 });
  return { machines, machine, calls, box };
}
async function entered(handlers: Partial<Record<OperationName, Handler>> = {}) {
  const f = await connected(handlers); f.machines.enter(); await f.machines.idle(); return f;
}
const named = (f: Awaited<ReturnType<typeof connected>>, name: OperationName) => f.calls.filter(c => c.name === name).map(c => c.input);
const cell = (f: Awaited<ReturnType<typeof connected>>, name: string, machine: string) =>
  gridRows(perMachine(f.machines.state)).find(row => row.name === name)?.cells[machine];

test('browser preview reads nothing', async () => {
  const machines = new MachinesController(null, new MachineController(null)); machines.enter(); await machines.idle();
  assert.equal(machines.state.native, false); assert.deepEqual(machines.state.columns, []);
});
test('entering reads remote access and machines, then the skills of every reachable machine without re-inspecting', async () => {
  const f = await entered();
  assert.deepEqual(f.calls.slice(0, 2).map(c => c.name).sort(), ['myMachines', 'remoteAccess']);
  assert.deepEqual(named(f, 'machineSkills').map(i => i.machine).sort(), ['n-pc', 'this']);
  assert.ok(named(f, 'machineSkills').every(i => !('fresh' in i)));
  assert.ok(f.calls.every(c => (c.input.scope as { kind: string }).kind === 'machine'));
  assert.deepEqual(f.machines.state.columns.map(c => [c.ref, c.name, c.reach]), [['this', 'mac', 'ok'], ['n-pc', 'pc', 'ok'], ['n-old', 'old', 'offline']]);
  assert.equal(cell(f, 'tdd', 'this'), 'installed'); assert.equal(cell(f, 'tdd', 'n-pc'), 'absent'); assert.equal(cell(f, 'tdd', 'n-old'), 'offline');
  f.machines.leave(); f.machines.enter(); await f.machines.idle(); assert.equal(named(f, 'myMachines').length, 1, 'a second visit keeps the read');
});
test('Refresh asks machines to inspect again', async () => {
  const f = await entered();
  await f.machines.refresh('n-pc'); assert.deepEqual(named(f, 'machineSkills').at(-1), { scope: { kind: 'machine' }, machine: 'n-pc', fresh: true });
  await f.machines.refresh(); assert.equal(named(f, 'myMachines').length, 2);
  assert.ok(named(f, 'machineSkills').slice(-2).every(i => i.fresh === true));
});
test('setCell sends one machine, shows working while its run runs, then reads that machine again', async () => {
  const run = deferred<unknown>(); let polls = 0;
  const f = await entered({ machineRun: () => (++polls === 1 ? receipt('running') : run.promise) });
  const done = f.machines.setCell({ source: 'owner/skills', name: 'tdd' }, 'n-pc', true);
  await new Promise(resolve => setTimeout(resolve, 5));
  const [apply] = named(f, 'applySkillOnMachines');
  assert.equal(apply!.action, 'install'); assert.deepEqual(apply!.machines, ['n-pc']); assert.equal(apply!.source, 'owner/skills'); assert.equal(apply!.name, 'tdd');
  assert.match(apply!.requestId as string, /^[0-9a-f-]{36}$/);
  assert.equal(cell(f, 'tdd', 'n-pc'), 'working');
  f.box.skills['n-pc'] = [skill('tdd')]; run.resolve(receipt('succeeded')); await done; await f.machines.idle();
  assert.deepEqual(named(f, 'machineRun').map(i => [i.machine, i.runId]), [['n-pc', 'run-n-pc'], ['n-pc', 'run-n-pc']]);
  assert.deepEqual(named(f, 'machineSkills').at(-1), { scope: { kind: 'machine' }, machine: 'n-pc' });
  assert.equal(cell(f, 'tdd', 'n-pc'), 'installed');
  await f.machines.setCell({ source: 'owner/skills', name: 'tdd' }, 'this', false);
  assert.equal(named(f, 'applySkillOnMachines').at(-1)!.action, 'remove');
  assert.notEqual(named(f, 'applySkillOnMachines').at(-1)!.requestId, apply!.requestId, 'each user action has its own request ID');
});
test('a failed run or a refusal shows its reason in the cell', async () => {
  const f = await entered({ machineRun: () => ({ ...receipt('failed'), result: { status: 'failed', message: 'EBUSY while copying' } }) });
  await f.machines.setCell({ source: 'owner/skills', name: 'tdd' }, 'n-pc', true);
  assert.deepEqual(cell(f, 'tdd', 'n-pc'), { failed: 'Install failed. EBUSY while copying.' });
  const g = await entered({ applySkillOnMachines: () => ({ results: [{ machine: 'n-pc', name: 'pc', outcome: { status: 'refused', reason: 'That skill is pinned elsewhere' } }] }) });
  await g.machines.setCell({ source: 'owner/skills', name: 'tdd' }, 'n-pc', true);
  assert.deepEqual(cell(g, 'tdd', 'n-pc'), { failed: 'That skill is pinned elsewhere' });
  assert.equal(named(g, 'machineRun').length, 0);
});
test('an offline result leaves the cell unchanged and says the machine is offline', async () => {
  const f = await entered({ applySkillOnMachines: () => ({ results: [{ machine: 'n-pc', name: 'pc', outcome: { status: 'offline' } }] }) });
  await f.machines.setCell({ source: 'owner/skills', name: 'tdd' }, 'n-pc', true);
  assert.equal(cell(f, 'tdd', 'n-pc'), 'absent'); assert.equal(named(f, 'machineRun').length, 0);
  assert.deepEqual(f.machines.state.notices, ['pc is offline. Nothing changed there.']);
});
test('move installs on the target, then removes from the source once the install succeeded, and reports both', async () => {
  const f = await entered();
  f.box.skills['n-pc'] = [skill('tdd')]; f.box.skills.this = [skill('tdd', { state: 'absent' })];
  await f.machines.move({ source: 'owner/skills', name: 'tdd' }, 'this', 'n-pc');
  const applies = named(f, 'applySkillOnMachines');
  assert.deepEqual(applies.map(i => [i.action, i.machines]), [['install', ['n-pc']], ['remove', ['this']]]);
  assert.equal(applies[0]!.requestId, applies[1]!.requestId, 'a move is one user action');
  assert.equal(cell(f, 'tdd', 'n-pc'), 'installed'); assert.equal(cell(f, 'tdd', 'this'), 'absent');
  const g = await entered({ machineRun: () => receipt('failed') });
  await g.machines.move({ source: 'owner/skills', name: 'tdd' }, 'this', 'n-pc');
  assert.deepEqual(named(g, 'applySkillOnMachines').map(i => i.action), ['install'], 'nothing is removed when the install did not land');
  assert.deepEqual(g.machines.state.notices, ['Kept tdd on mac because it didn’t install on pc.']);
});
test('install and copy send the chosen machines; unreachable columns and unknown sources never write', async () => {
  const f = await entered();
  await f.machines.install(' owner/other ', ' lint ', 'all');
  assert.deepEqual(named(f, 'applySkillOnMachines').map(i => [i.source, i.name, i.machines]), [['owner/other', 'lint', 'all']]);
  await f.machines.copy({ source: 'owner/skills', name: 'tdd' }, ['n-pc']);
  assert.deepEqual(named(f, 'applySkillOnMachines').at(-1)!.machines, ['n-pc']);
  const count = named(f, 'applySkillOnMachines').length;
  await f.machines.setCell({ source: 'owner/skills', name: 'tdd' }, 'n-old', true);
  await f.machines.copy({ source: null, name: 'handmade' }, ['n-pc']);
  assert.equal(named(f, 'applySkillOnMachines').length, count);
});
test('turning remote access on saves it and reads the machines again', async () => {
  let enabled = false;
  const f = await entered({ remoteAccess: () => access({ enabled }), setRemoteAccess: input => { enabled = input.enabled as boolean; return access({ enabled }); } });
  await f.machines.setRemoteAccess(true);
  assert.deepEqual(named(f, 'setRemoteAccess'), [{ scope: { kind: 'machine' }, enabled: true }]);
  assert.equal(f.machines.state.access?.enabled, true); assert.equal(named(f, 'myMachines').length, 2);
});
test('gridRows merges machines by source and name and marks unread machines offline', () => {
  const rows = gridRows({
    this: { skills: [skill('tdd'), skill('handmade', { source: null, state: 'undeclared' })] },
    pc: { skills: [skill('tdd', { state: 'profile-off' }), skill('lint', { state: 'undeclared' })], changes: { [JSON.stringify(['owner/skills', 'tdd'])]: 'working' } },
    old: { skills: null },
  });
  assert.deepEqual(rows.map(r => [r.source, r.name, r.cells]), [
    [null, 'handmade', { this: 'undeclared', pc: 'absent', old: 'offline' }],
    ['owner/skills', 'lint', { this: 'absent', pc: 'undeclared', old: 'offline' }],
    ['owner/skills', 'tdd', { this: 'installed', pc: 'working', old: 'offline' }],
  ]);
});
