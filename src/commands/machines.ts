import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Effect } from 'effect';
import { AgentError, AgentUnavailable, connectAgent, type AgentConnection } from '../agent-client.ts';
import { resolvePaths, runCommand } from '../machine.ts';
import { NOT_RUNNING } from './agent.ts';
import type { OperationInput, OperationName, OperationOutput } from '@nortuscc/agent/operations';

const USAGE = `Usage: nortuscc machines [skills <name|this> | install|remove <owner/repo> <skill> --on <name,...|all> | remote on|off]
  machines                   list my machines and whether each can be reached
  machines skills <name>     the skills on a machine, with their state ("this" is this machine)
  machines install|remove <owner/repo> <skill> --on <name,...|all>
                             run the change on those machines and wait for each to finish
  machines remote on|off     let my other machines act on this one (needs Tailscale)`;

const NEEDS_AGENT = `${NOT_RUNNING}. Remote actions need the agent.`;
const NO_ANSWER = 'nortuscc: the agent did not answer in time';
const POLL_MS = 1000;
const WAIT_MS = 120_000;
const scope = { kind: 'machine' } as const;

type Machines = OperationOutput<'myMachines'>;
type Op = <N extends OperationName>(operation: N, input: OperationInput<N>) => Promise<OperationOutput<N>>;

const usage = (problem?: string): number => {
  if (problem) console.error(`nortuscc: ${problem}\n`);
  console.error(USAGE);
  return 2;
};

const myMachines = (op: Op) => op('myMachines', { scope });

const REACH: Record<string, string> = {
  ok: 'reachable', offline: 'offline', 'app-closed': 'app closed', 'remote-off': 'remote access off', incompatible: 'needs update',
};

// A name is `this` (or this machine's own name), or one of the other machines', matched ignoring case.
// Unknown and ambiguous names fail with the known names.
function resolve(machines: Machines, name: string): { ref: string; label: string } | string {
  const wanted = name.toLowerCase();
  const known = [...(machines.self ? [machines.self.name] : []), ...machines.machines.map((m) => m.name)];
  const list = `known machines: this${known.length ? `, ${known.join(', ')}` : ''}`;
  const hits = machines.machines.filter((m) => m.name.toLowerCase() === wanted);
  const isSelf = wanted === 'this' || machines.self?.name.toLowerCase() === wanted;
  if (hits.length + (isSelf ? 1 : 0) > 1) return `'${name}' names more than one machine; ${list}`;
  if (isSelf) return { ref: 'this', label: machines.self?.name ?? 'this' };
  if (hits.length === 0) return `no machine named '${name}'; ${list}`;
  return { ref: hits[0]!.nodeId, label: hits[0]!.name };
}

async function list(op: Op): Promise<number> {
  const { self, machines, tailscale } = await myMachines(op);
  if (machines.length === 0 && !self) console.log(`no machines found (Tailscale: ${tailscale})`);
  for (const m of machines) console.log(`${m.name}\t${m.os}\t${REACH[m.reach] ?? m.reach}`);
  if (self) console.log(`${self.name}\t${self.os}\tthis machine`);
  return 0;
}

async function skills(op: Op, name: string): Promise<number> {
  const target = resolve(await myMachines(op), name);
  if (typeof target === 'string') return usage(target);
  const { skills } = await op('machineSkills', { scope, machine: target.ref });
  for (const s of skills) console.log(`${s.source ? `${s.source} ` : ''}${s.name}\t${s.state}`);
  return 0;
}

const FINISHED = ['succeeded', 'failed', 'cancelled', 'interrupted', 'abandoned'];

// Starts the change, then follows each started run until it finishes; exits 1 unless every machine succeeded.
async function change(op: Op, action: 'install' | 'remove', source: string, skill: string, on: string): Promise<number> {
  let machines: 'all' | string[];
  const labels = new Map<string, string>();
  if (on === 'all') machines = 'all';
  else {
    const known = await myMachines(op);
    machines = [];
    for (const name of on.split(',').map((n) => n.trim()).filter(Boolean)) {
      const target = resolve(known, name);
      if (typeof target === 'string') return usage(target);
      machines.push(target.ref);
      labels.set(target.ref, target.label);
    }
    if (machines.length === 0) return usage('--on needs at least one machine');
  }
  const { results } = await op('applySkillOnMachines', { scope, requestId: randomUUID(), source, name: skill, action, machines });
  const verb = action === 'install' ? 'installed' : 'removed';
  const deadline = Date.now() + WAIT_MS;
  const follow = async (r: (typeof results)[number]): Promise<{ line: string; ok: boolean }> => {
    const who = r.name || labels.get(r.machine) || r.machine;
    if (r.outcome.status === 'offline') return { line: `${who}: offline, nothing was started`, ok: false };
    if (r.outcome.status === 'refused') return { line: `${who}: refused: ${r.outcome.reason}`, ok: false };
    try {
      for (;;) {
        const run = await op('machineRun', { scope, machine: r.machine, runId: r.outcome.runId });
        if (run.state === 'succeeded') return { line: `${who}: ${verb}`, ok: true };
        if (FINISHED.includes(run.state)) return { line: `${who}: ${run.state}`, ok: false };
        if (Date.now() >= deadline) return { line: `${who}: still running after ${WAIT_MS / 1000} s`, ok: false };
        await sleep(POLL_MS);
      }
    } catch (error) {
      return { line: `${who}: could not follow the run (${error instanceof Error ? error.message : String(error)})`, ok: false };
    }
  };
  const outcomes = await Promise.all(results.map(follow));
  const failed = outcomes.some((o) => !o.ok);
  const lines = outcomes.map((o) => o.line);
  for (const line of lines) console.log(line);
  return failed ? 1 : 0;
}

async function remote(op: Op, setting: string): Promise<number> {
  if (setting !== 'on' && setting !== 'off') return usage('machines remote takes on or off');
  const result = await op('setRemoteAccess', { scope, enabled: setting === 'on' });
  console.log(`remote access: ${result.enabled ? 'on' : 'off'} (Tailscale: ${result.tailscale})`);
  return 0;
}

export async function run(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const flags = rest.indexOf('--on');
  const on = flags >= 0 ? rest[flags + 1] : undefined;
  const positional = flags >= 0 ? rest.filter((_, i) => i !== flags && i !== flags + 1) : rest;
  let job: (op: Op) => Promise<number>;
  if (sub === undefined) job = list;
  else if (sub === 'skills' && positional.length === 1) job = (op) => skills(op, positional[0]!);
  else if ((sub === 'install' || sub === 'remove') && positional.length === 2 && on) job = (op) => change(op, sub, positional[0]!, positional[1]!, on);
  else if (sub === 'remote' && positional.length === 1) job = (op) => remote(op, positional[0]!);
  else return usage();
  return runCommand(() => Effect.gen(function* () {
    const paths = yield* resolvePaths((m) => console.error(m));
    return yield* Effect.tryPromise({
      try: async () => {
        let conn: AgentConnection;
        try {
          conn = await connectAgent(paths);
        } catch (error) {
          if (!(error instanceof AgentUnavailable)) throw error;
          console.error(NEEDS_AGENT);
          return 1;
        }
        try {
          return await job((operation, input) => conn.request({ command: 'operation', operation, input }));
        } catch (error) {
          if (!(error instanceof AgentError)) throw error;
          console.error(error.code === 'TIMEOUT' ? NO_ANSWER : `nortuscc: ${error.message}`);
          return 1;
        } finally {
          conn.close();
        }
      },
      catch: (error) => error,
    });
  }));
}
