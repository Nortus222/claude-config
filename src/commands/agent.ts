import { fstatSync } from 'node:fs';
import { join } from 'node:path';
import { Cause, Effect } from 'effect';
import { configDomain, Fs, integrationsDomain, skillsDomain, type MachinePathsValue } from '@nortuscc/machine';
import {
  decodeWireStatus, decodeHostedState, decodeSignInResult, decodeRequest, agentLayer, AgentStateStore, installService, POLICIES, runAgent, trustOwnSetup, uninstallService, unitPath,
  type ApplyResult, type InspectResult, type Policy, type PreviewResult, type RunEvent, type RunProgress, type ServiceFailed,
  type ServiceTarget, type WireStatus,
} from '@nortuscc/agent';
import { setupSourceLayer } from '@nortuscc/sync';
import { AgentError, AgentUnavailable, connectAgent, type AgentConnection } from '../agent-client.ts';
import { agentProgram, checkoutVersion, serviceTarget } from '../agent-service.ts';
import { CHECKOUT, resolvePaths, runCommand } from '../machine.ts';
import { confirm as realConfirm } from '../prompt.ts';
import { select as realSelect, type Choice } from '../select.ts';

const USAGE = `Usage: nortuscc agent install [--linger] | uninstall | run | status | review | resume | policy <p>
  agent install [--linger]   run the local agent as a login service from this checkout
                             --linger (Linux) keeps it running with nobody logged in
  agent uninstall            stop the agent and remove its login service
  agent run                  run the agent in the foreground (the service runs this)
  agent status               show the running agent's policy, pause and pending items
  agent review               choose pending, held and drifted items and apply them (needs a terminal)
  agent resume               resume a paused agent
  agent hosted | sign-in [name] | sign-out | sync
                             account state, device sign-in, sign-out or immediate sync
  agent trust <setupId>       trust an offered setup on this machine
  agent decide <setupId> <itemId> <revision> <accept|skip>
                             record an account choice, including while offline
  agent machine <name|report-status> <value>
                             change the display name or reporting (on/off)
  agent policy <auto-apply|notify|manual>
                             set how the agent treats accepted items`;

const APP_MANAGES = 'nortuscc: the desktop app manages the agent on this machine; manage it from the app.';

const usage = (problem?: string): number => {
  if (problem) console.error(`nortuscc: ${problem}\n`);
  console.error(USAGE);
  return 2;
};

// This machine's service target, or the exit code when the platform has no login service.
const targetFor = (paths: MachinePathsValue): ServiceTarget | number => {
  const target = serviceTarget(paths);
  if (target) return target;
  console.error(`nortuscc: the agent's login service is not supported on ${process.platform}`);
  return 2;
};

// A service manager failure reads as the command that failed and why.
const serviceFailed = (err: ServiceFailed) => Effect.sync(() => {
  console.error(`nortuscc: ${err.command} exited ${err.code}: ${err.reason}`);
  return 1;
});

// Trusts this checkout, writes and registers the login service, and records the CLI as its installer.
const install = (linger: boolean) =>
  Effect.gen(function* () {
    const paths = yield* resolvePaths((m) => console.error(m));
    const target = targetFor(paths);
    if (typeof target === 'number') return target;
    return yield* Effect.gen(function* () {
      const state = yield* AgentStateStore;
      if ((yield* state.read).installedBy === 'app') {
        console.error(APP_MANAGES);
        return 1;
      }
      const trusted = yield* trustOwnSetup('cli');
      if (trusted === undefined) {
        console.error(`nortuscc: ${join(paths.stateRoot, 'agent', 'setups.json')} is not valid, so nothing was installed; fix it by hand and re-run.`);
        return 1;
      }
      console.log(`trusted: ${trusted.repoUrl ?? trusted.checkout}`);
      const program = agentProgram(paths);
      yield* installService(target, program, { linger });
      yield* state.update((s) => ({ ...s, installedBy: 'cli', agentVersion: checkoutVersion() }));
      console.log(`agent installed: ${unitPath(target)}`);
      console.log(`log: ${program.logPath}`);
      return 0;
    }).pipe(Effect.catchTag('ServiceFailed', serviceFailed), Effect.provide(agentLayer(paths)));
  });

// Stops and removes the login service and the agent's socket and token; History, decisions,
// backups and trusted setups stay. Nothing installed is not an error.
const uninstall = Effect.gen(function* () {
  const paths = yield* resolvePaths((m) => console.error(m));
  const target = targetFor(paths);
  if (typeof target === 'number') return target;
  return yield* Effect.gen(function* () {
    const state = yield* AgentStateStore;
    const before = yield* state.read;
    if (before.installedBy === 'app') {
      console.error(APP_MANAGES);
      return 1;
    }
    yield* uninstallService(target);
    const fs = yield* Fs;
    for (const name of ['agent.sock', 'agent.token']) yield* fs.remove(join(paths.stateRoot, 'agent', name));
    if (before.installedBy !== undefined || before.agentVersion !== undefined) {
      // update drops the owned fields its result leaves out.
      yield* state.update(({ installedBy: _installedBy, agentVersion: _agentVersion, ...rest }) => rest);
    }
    console.log('agent uninstalled; History, decisions, backups and trusted setups are kept');
    return 0;
  }).pipe(Effect.catchTag('ServiceFailed', serviceFailed), Effect.provide(agentLayer(paths)));
});

// Runs the agent in the foreground, serving its socket off Windows, until SIGTERM, SIGINT or a
// client's `shutdown`, each of which exits 0.
async function runForeground(): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    return await Effect.runPromise(Effect.gen(function* () {
      const paths = yield* resolvePaths((m) => console.error(m));
      const lock = join(paths.stateRoot, 'agent', 'agent.lock');
      // Each job builds its domains from its own paths, so the integrations domain reads the job's
      // snapshot, as ADR 0016 requires.
      const domains = (jobPaths: MachinePathsValue) => [configDomain, integrationsDomain({ paths: jobPaths, env: process.env }), skillsDomain];
      // Windows has no socket server yet; there the agent runs without IPC.
      const ipc = process.platform !== 'win32';
      let redirected = false;
      if (!ipc) {
        // Headless console handles may be absent; only a regular file proves existing redirection.
        try { redirected = fstatSync(process.stdout.fd).isFile(); } catch {}
      }
      return yield* runAgent({
        ...(process.env.NORTUSCC_HOSTED_URL === undefined ? {} : { hosted: { url: process.env.NORTUSCC_HOSTED_URL, platform: process.platform } }),
        paths, domains, source: setupSourceLayer(paths), agentVersion: checkoutVersion(), ipc, notifications: { platform: process.platform }, signal: controller.signal,
        ...(!ipc && !redirected ? { logOutput: { stdout: process.stdout, stderr: process.stderr } } : {}),
        onStarted: () => console.error(`nortuscc agent: running from ${CHECKOUT} (pid ${process.pid})`),
      }).pipe(
        Effect.as(0),
        Effect.catchTag('LockHeld', (err) => Effect.sync(() => {
          console.error(err.path === lock ? `nortuscc: another agent (pid ${err.pid}) is running` : `nortuscc: ${err.message}`);
          return 1;
        })),
      );
    }).pipe(Effect.catchCause((cause) => Effect.sync(() => {
      const error = Cause.squash(cause);
      console.error(`nortuscc: ${error instanceof Error && error.message ? error.message : String(error)}`);
      return 1;
    }))));
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

const NOT_RUNNING = 'nortuscc: the agent is not running (start it with: nortuscc agent install, or nortuscc agent run)';
const NO_ANSWER = 'nortuscc: the agent did not answer in time';
const LOST = 'nortuscc: lost the agent during the run; check nortuscc agent status';
const STARTING = 'nortuscc: the agent is still starting; try again in a moment';

// Runs `body` over a connection to the running agent (this machine's, unless `connect` is given);
// no agent prints NOT_RUNNING and exits 1, and so does an unanswered request, with NO_ANSWER.
// `signal` aborts on the first Ctrl-C, or when `injected` (a test's) aborts.
const withAgent = (
  body: (conn: AgentConnection, signal: AbortSignal) => Promise<number>, connect?: () => Promise<AgentConnection>, injected?: AbortSignal,
) =>
  runCommand((ctrlC) => Effect.gen(function* () {
    const signal = injected ? AbortSignal.any([ctrlC, injected]) : ctrlC;
    const open = connect ?? (yield* Effect.map(resolvePaths((m) => console.error(m)), (paths) => () => connectAgent(paths)));
    return yield* Effect.tryPromise({
      try: async () => {
        let conn: AgentConnection;
        try {
          conn = await open();
        } catch (error) {
          if (!(error instanceof AgentUnavailable)) throw error;
          console.error(NOT_RUNNING);
          return 1;
        }
        try {
          return await body(conn, signal);
        } catch (error) {
          if (!(error instanceof AgentError && error.code === 'TIMEOUT')) throw error;
          console.error(NO_ANSWER);
          return 1;
        } finally {
          conn.close();
        }
      },
      catch: (error) => error,
    });
  }));

const yesNo = (value: boolean) => (value ? 'yes' : 'no');

// Prints the agent's last status; exits 1 when it carries an error.
const printStatus = (status: WireStatus): number => {
  const { counts } = status;
  console.log(`policy: ${status.policy}`);
  console.log(status.paused === null ? 'paused: no' : `paused: yes, since ${status.paused.at}: ${status.paused.reason}`);
  console.log(`trusted: ${yesNo(status.trusted)}`);
  console.log(`pending: ${counts.pending}, held: ${counts.held}, ready: ${counts.ready}, drift: ${counts.drift}`);
  console.log(`conflicts: ${status.conflicts.length === 0 ? 'none' : status.conflicts.join(', ')}`);
  console.log(`last inspection: ${status.at}`);
  if (status.error === undefined) return 0;
  console.log(`error: ${status.error}${status.detail === undefined ? '' : `: ${status.detail}`}`);
  return 1;
};

// Stand-ins for the terminal, Ctrl-C and the agent, so a test can drive the commands that talk to the agent.
export type AgentDeps = {
  isTTY?: boolean;
  select?: typeof realSelect;
  confirm?: typeof realConfirm;
  connect?: () => Promise<AgentConnection>;
  signal?: AbortSignal;
};

// Ctrl-C before the apply starts: nothing was applied.
class Cancelled extends Error {}

// `request`'s answer, or Cancelled as soon as `signal` aborts.
const unlessAborted = <A>(request: Promise<A>, signal: AbortSignal): Promise<A> => {
  if (signal.aborted) return Promise.reject(new Cancelled());
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([request, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const withBackups = (text: string, backups: string | undefined) => (backups === undefined ? text : `${text}; backups in ${backups}`);

// One progress line; terminal events say how the run ended and where its backups are.
const progressLine = (p: RunProgress): string => {
  switch (p.type) {
    case 'started':
      return `started ${p.index + 1}/${p.total}: ${p.step.summary}`;
    case 'finished':
      return `finished ${p.index + 1}/${p.total}: ${p.key} ${p.outcome}${p.note ? `: ${p.note}` : ''}`;
    case 'done':
      return withBackups(`done: ${p.ok} ok, ${p.failed} failed`, p.backups);
    case 'cancelled':
      return withBackups(`cancelled: ${plural(p.remaining.length, 'step')} not run`, p.backups);
    case 'failed':
      return `failed: ${p.message}`;
  }
};

// The picker rows: pending items (inert, and held with their reasons) checked, drift unchecked.
const reviewChoices = (inspected: InspectResult & { readonly status: WireStatus }): Choice[] => {
  const byKey = new Map(inspected.items.map((i) => [i.key, i]));
  const label = (key: string) => byKey.get(key)?.label ?? key;
  const note = (key: string) => byKey.get(key)?.note ?? byKey.get(key)?.state ?? '';
  const { pending, drift } = inspected.status;
  return [
    ...pending.filter((p) => p.verdict === 'inert').map((p) => ({ key: p.key, group: 'pending', label: label(p.key), note: note(p.key), checked: true })),
    ...pending.filter((p) => p.verdict === 'held').map((p) => ({ key: p.key, group: 'held', label: label(p.key), note: p.reason ?? note(p.key), checked: true })),
    ...drift.map((key) => ({ key, group: 'drift', label: label(key), note: note(key), checked: false })),
  ];
};

// Inspect through the agent, choose, preview, confirm, apply and stream the run. Exits 0 when the
// run is done with no failures or the person applies nothing, 1 otherwise, including when the
// connection closes before the run ends. Ctrl-C before the apply exits 130 with nothing applied;
// during the run it asks the agent to cancel.
const review = (deps: AgentDeps, isTTY: boolean) =>
  withAgent(async (conn, signal) => {
    try {
      return await reviewWith(conn, signal, deps, isTTY);
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      console.log('cancelled; nothing was applied');
      return 130;
    }
  }, deps.connect, deps.signal);

// The review itself; throws Cancelled when Ctrl-C comes before the apply.
const reviewWith = async (conn: AgentConnection, signal: AbortSignal, deps: AgentDeps, isTTY: boolean): Promise<number> => {
  const inspected = await unlessAborted(conn.request<InspectResult & { status: WireStatus }>({ command: 'inspect' }), signal);
  const choices = reviewChoices(inspected);
  if (choices.length === 0) {
    console.log('nothing to review');
    return 0;
  }
  const picked = await (deps.select ?? realSelect)(choices, { title: 'choose what to apply', isTTY });
  if (picked === null) {
    console.log('cancelled; nothing was applied');
    return 0;
  }
  const chosen = new Set(picked);
  const exclude = choices.filter((c) => !chosen.has(c.key)).map((c) => c.key);
  const preview = await unlessAborted(conn.request<PreviewResult>({ command: 'preview', exclude }), signal);
  const { steps, skipped } = preview.plan;
  for (const step of steps) console.log(`  ${step.summary}`);
  for (const skip of skipped) console.log(`  skipped ${skip.key}: ${skip.reason}`);
  if (steps.length === 0) {
    console.log('nothing to apply');
    return 0;
  }
  if (!(await (deps.confirm ?? realConfirm)(`Apply these ${steps.length} step(s)?`, { isTTY }))) {
    console.log('declined; nothing was applied');
    return 0;
  }
  if (signal.aborted) throw new Cancelled();

  // Events can arrive before the apply answer is seen, so they wait for the run id.
  let runId: string | undefined;
  const early: RunEvent[] = [];
  let end!: (p: RunProgress) => void;
  const ended = new Promise<RunProgress>((resolve) => { end = resolve; });
  let offClose = () => {};
  const lost = new Promise<'lost'>((resolve) => { offClose = conn.onClose(() => resolve('lost')); });
  const onProgress = (e: RunEvent) => {
    if (e.runId !== runId) return;
    console.log(progressLine(e.progress));
    if (e.progress.type === 'done' || e.progress.type === 'cancelled' || e.progress.type === 'failed') end(e.progress);
  };
  const off = conn.onEvent((event) => {
    const e = event as RunEvent;
    if (e.event !== 'progress') return;
    if (runId === undefined) early.push(e);
    else onProgress(e);
  });
  const cancel = () => {
    console.log('cancelling…');
    conn.request({ command: 'cancel' }).catch(() => {});
  };
  try {
    const applied = await conn.request<ApplyResult>({ command: 'apply', planId: preview.planId });
    if (applied.status === 'stale') {
      console.log('the machine changed; review again');
      return 1;
    }
    runId = applied.runId;
    for (const e of early.splice(0)) onProgress(e);
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    const last = await Promise.race([ended, lost]);
    if (last === 'lost') {
      console.error(LOST);
      return 1;
    }
    return last.type === 'done' && last.failed === 0 ? 0 : 1;
  } finally {
    off();
    offClose();
    signal.removeEventListener('abort', cancel);
  }
};

export async function run(args: string[] = [], deps: AgentDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'hosted':
    case 'sign-in':
    case 'sign-out':
    case 'sync':
    case 'trust':
    case 'decide':
    case 'machine': {
      let command: Record<string, unknown>;
      if (sub === 'hosted' || sub === 'sign-out' || sub === 'sync') {
        if (rest.length) return usage('this command takes no arguments');
        command = { command: sub === 'hosted' ? 'hostedState' : sub === 'sign-out' ? 'signOut' : 'syncNow' };
      } else if (sub === 'sign-in') {
        if (rest.length > 1) return usage('quote a machine name containing spaces');
        command = { command: 'signIn', ...(rest[0] === undefined ? {} : { name: rest[0] }) };
      } else if (sub === 'trust') {
        if (rest.length !== 1) return usage('trust needs an offered setup ID');
        command = { command: 'trustSetup', setupId: rest[0] };
      } else if (sub === 'decide') {
        if (rest.length !== 4 || !/^[1-9][0-9]*$/.test(rest[2]!)) return usage('decide needs setup ID, item ID, numeric revision and accept/skip');
        command = { command: 'decide', items: [{ setupId: rest[0], id: rest[1], revision: Number(rest[2]), decision: rest[3] }] };
      } else {
        if (rest.length !== 2 || !['name', 'report-status'].includes(rest[0]!) || rest[0] === 'report-status' && !['on', 'off'].includes(rest[1]!)) return usage('machine needs name <name> or report-status <on|off>');
        command = { command: 'machineSettings', patch: rest[0] === 'name' ? { name: rest[1] } : { reportStatus: rest[1] === 'on' } };
      }
      try { decodeRequest({ ...command, version: 3, id: 'cli' }); } catch { return usage('invalid hosted arguments'); }
      return withAgent(async (conn) => {
        const result = await conn.request(command);
        if (sub === 'sign-in') {
          const started = decodeSignInResult(result);
          console.log(`Open ${started.verificationUri} and enter ${started.userCode}. The agent completes sign-in in the background.`);
        } else if (sub === 'decide') return printStatus(decodeWireStatus(result));
        else {
          const state = decodeHostedState(result);
          console.log(`hosted: ${state.enabled ? state.auth : 'disabled'}${state.signingIn ? ' (sign-in pending)' : ''}`);
          if (state.accountId) console.log(`account: ${state.accountId}`);
          for (const setup of state.setups) console.log(`offered: ${setup.setupId} (${setup.name}), revision ${setup.latestRevision}`);
          if (state.machine) console.log(`policy: ${state.machine.policy}; report status: ${yesNo(state.machine.reportStatus)}`);
          if (state.error) console.log(`hosted error: ${state.error}`);
        }
        return 0;
      }, deps.connect);
    }
    case 'install': {
      const unknown = rest.find((arg) => arg !== '--linger');
      if (unknown !== undefined) return usage(`unknown option ${unknown}`);
      const linger = rest.includes('--linger');
      if (linger && process.platform !== 'linux') {
        console.error('nortuscc: --linger is for Linux only');
        return 2;
      }
      return runCommand(() => install(linger));
    }
    case 'uninstall':
      if (rest.length > 0) return usage(`unknown option ${rest[0]}`);
      return runCommand(() => uninstall);
    case 'run':
      if (rest.length > 0) return usage(`unknown option ${rest[0]}`);
      return runForeground();
    case 'status':
      if (rest.length > 0) return usage(`unknown option ${rest[0]}`);
      return withAgent(async (conn) => {
        try {
          return printStatus(await conn.request<WireStatus>({ command: 'status' }));
        } catch (error) {
          if (!(error instanceof AgentError && error.code === 'NO_REPORT')) throw error;
          console.error(STARTING);
          return 1;
        }
      }, deps.connect);
    case 'review': {
      if (rest.length > 0) return usage(`unknown option ${rest[0]}`);
      const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
      if (!isTTY) {
        console.error('nortuscc: agent review needs a terminal');
        return 2;
      }
      return review(deps, isTTY);
    }
    case 'resume':
      if (rest.length > 0) return usage(`unknown option ${rest[0]}`);
      return withAgent(async (conn) => {
        if (conn.hello.paused === null) {
          console.log('not paused');
          return 0;
        }
        await conn.request<WireStatus>({ command: 'resume' });
        console.log('resumed');
        return 0;
      }, deps.connect);
    case 'policy': {
      const [policy, ...extra] = rest;
      if (policy === undefined || !POLICIES.includes(policy as Policy)) {
        return usage(policy === undefined ? 'agent policy needs one of auto-apply, notify, manual' : `unknown policy '${policy}'`);
      }
      if (extra.length > 0) return usage(`unknown option ${extra[0]}`);
      return withAgent(async (conn) => {
        const status = await conn.request<WireStatus>({ command: 'setPolicy', policy });
        console.log(`policy: ${status.policy}`);
        return 0;
      }, deps.connect);
    }
    default:
      return usage(sub === undefined ? undefined : `unknown agent command '${sub}'`);
  }
}
