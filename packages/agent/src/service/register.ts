import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Data, Effect } from 'effect';
import { Fs, FsFailed, Processes } from '@nortuscc/machine';
import { LAUNCH_AGENT_LABEL, renderLaunchAgent, renderScheduledTask, renderSystemdUnit, SCHEDULED_TASK, SYSTEMD_UNIT, type ServiceProgram } from './units.ts';

// Where and as whom the service is registered: every machine fact, passed in by the caller.
export type ServiceTarget = {
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly home: string;
  readonly uid: number; // macOS gui/<uid>
  readonly user: string; // loginctl, Task UserId
  readonly stateRoot: string;
  readonly label?: string; // macOS label; default LAUNCH_AGENT_LABEL
  readonly unitDir?: string; // where the unit file goes; default per OS
};

// A service manager command exited non-zero, or the unit could not be rendered.
export class ServiceFailed extends Data.TaggedError('ServiceFailed')<{ readonly command: string; readonly code: number; readonly reason: string }> {
  override get message() {
    return `${this.command} failed (exit ${this.code}): ${this.reason}`;
  }
}

const labelOf = (target: ServiceTarget) => target.label ?? LAUNCH_AGENT_LABEL;

/** The unit file's path: the plist, the systemd user unit, or the XML that schtasks imports. */
export const unitPath = (target: ServiceTarget): string => {
  switch (target.platform) {
    case 'darwin': return join(target.unitDir ?? join(target.home, 'Library', 'LaunchAgents'), `${labelOf(target)}.plist`);
    case 'linux': return join(target.unitDir ?? join(target.home, '.config', 'systemd', 'user'), SYSTEMD_UNIT);
    case 'win32': return join(target.unitDir ?? join(target.stateRoot, 'agent'), `${SCHEDULED_TASK}.xml`);
  }
};

// The renderers throw on values a unit cannot carry; that is a failed install, not a defect.
const render = (target: ServiceTarget, program: ServiceProgram) =>
  Effect.try({
    try: () => {
      switch (target.platform) {
        case 'darwin': return renderLaunchAgent(labelOf(target), program);
        case 'linux': return renderSystemdUnit(program);
        case 'win32': return renderScheduledTask(program, target.user);
      }
    },
    catch: (err) => new ServiceFailed({ command: 'render unit', code: -1, reason: err instanceof Error ? err.message : String(err) }),
  });

const fsAttempt = <A>(op: string, path: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (err) => new FsFailed({ op, path, reason: err instanceof Error ? err.message : String(err) }) });

const BOM = '\uFEFF';

// Fs.writeTextAtomic writes UTF-8, but the task XML declares UTF-16 and schtasks /XML reads it as
// such, so on Windows the file is written here as UTF-16LE with a byte-order mark.
const writeUnit = (target: ServiceTarget, text: string) =>
  target.platform === 'win32'
    ? fsAttempt('write', unitPath(target), async () => {
      await mkdir(dirname(unitPath(target)), { recursive: true });
      await writeFile(unitPath(target), BOM + text, 'utf16le');
    })
    : Fs.use((fs) => fs.writeTextAtomic(unitPath(target), text));

// The unit's current text, decoded as it was written; undefined when absent.
const readUnit = (target: ServiceTarget) =>
  target.platform === 'win32'
    ? fsAttempt('read', unitPath(target), () =>
      readFile(unitPath(target)).then(
        (bytes) => bytes.toString('utf16le').replace(/^\uFEFF/, ''),
        (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return undefined;
          throw err;
        },
      ))
    : Fs.use((fs) => fs.readText(unitPath(target)));

// Runs argv with its output captured, so an ignored failure prints nothing; a non-zero exit fails,
// carrying stderr, unless `ignored`. A command that cannot start fails too.
const exec = (argv: ReadonlyArray<string>, ignored = false) =>
  Effect.gen(function* () {
    const [cmd = '', ...args] = argv;
    const command = argv.join(' ');
    const done = yield* Processes.use((p) => p.run({ cmd, args, output: 'capture', stderr: 'capture' })).pipe(
      Effect.mapError((err) => new ServiceFailed({ command, code: -1, reason: err.message })),
    );
    if (done.code !== 0 && !ignored) {
      return yield* new ServiceFailed({ command, code: done.code, reason: done.stderr?.trim() || 'non-zero exit' });
    }
  });

const domain = (target: ServiceTarget) => `gui/${target.uid}`;
const service = (target: ServiceTarget) => `${domain(target)}/${labelOf(target)}`;
const systemctl = (...args: string[]) => ['systemctl', '--user', ...args];
const schtasks = (...args: string[]) => ['schtasks', ...args];

export type ServiceOptions = {
  readonly retryDelayMs?: number; // between launchctl bootstrap attempts; default 400 ms
};

const BOOTSTRAP_ATTEMPTS = 5;

// Replaces the loaded job with the unit on disk. bootout returns before the old job has gone, and a
// bootstrap meanwhile fails (exit 5 or 37), so bootstrap is retried a few times before it fails.
const rebootstrap = (target: ServiceTarget, options: ServiceOptions) =>
  Effect.gen(function* () {
    yield* exec(['launchctl', 'bootout', service(target)], true);
    const bootstrap = exec(['launchctl', 'bootstrap', domain(target), unitPath(target)]);
    for (let attempt = 1; attempt < BOOTSTRAP_ATTEMPTS; attempt++) {
      if ((yield* Effect.result(bootstrap))._tag === 'Success') return;
      yield* Effect.sleep(options.retryDelayMs ?? 400);
    }
    yield* bootstrap;
  });

// Replaces the task with the XML on disk and starts it. The old instance is ended first: with
// MultipleInstancesPolicy IgnoreNew, /Run does nothing while it still runs.
const recreateTask = (target: ServiceTarget) =>
  Effect.gen(function* () {
    yield* exec(schtasks('/End', '/TN', SCHEDULED_TASK), true);
    yield* exec(schtasks('/Create', '/TN', SCHEDULED_TASK, '/XML', unitPath(target), '/F'));
    yield* exec(schtasks('/Run', '/TN', SCHEDULED_TASK));
  });

// Loads the written unit into the service manager and starts it.
const register = (target: ServiceTarget, options: ServiceOptions) =>
  Effect.gen(function* () {
    switch (target.platform) {
      case 'darwin':
        yield* rebootstrap(target, options);
        return;
      case 'linux':
        yield* exec(systemctl('daemon-reload'));
        yield* exec(systemctl('enable', SYSTEMD_UNIT));
        yield* exec(systemctl('restart', SYSTEMD_UNIT));
        return;
      case 'win32':
        yield* recreateTask(target);
        return;
    }
  });

/** Writes the unit and registers it to start at login, starting it now. `linger` (Linux) keeps it running without a session. */
export const installService = (target: ServiceTarget, program: ServiceProgram, options: ServiceOptions & { readonly linger?: boolean } = {}) =>
  Effect.gen(function* () {
    const text = yield* render(target, program);
    if (target.platform === 'linux' && options.linger) yield* exec(['loginctl', 'enable-linger', target.user]);
    yield* writeUnit(target, text);
    yield* register(target, options);
  });

/** Stops and unregisters the service and removes its unit; an absent service is not an error. */
export const uninstallService = (target: ServiceTarget) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    switch (target.platform) {
      case 'darwin':
        yield* exec(['launchctl', 'bootout', service(target)], true);
        yield* fs.remove(unitPath(target));
        return;
      case 'linux':
        yield* exec(systemctl('disable', '--now', SYSTEMD_UNIT), true);
        yield* fs.remove(unitPath(target));
        // Ignored, so an uninstall with no user bus still succeeds once the unit is gone.
        yield* exec(systemctl('daemon-reload'), true);
        return;
      case 'win32':
        yield* exec(schtasks('/End', '/TN', SCHEDULED_TASK), true);
        yield* exec(schtasks('/Delete', '/TN', SCHEDULED_TASK, '/F'), true);
        yield* fs.remove(unitPath(target));
        return;
    }
  });

/** Rewrites the unit when its text changed, then restarts the running service. */
export const restartService = (target: ServiceTarget, program: ServiceProgram, options: ServiceOptions = {}) =>
  Effect.gen(function* () {
    const text = yield* render(target, program);
    const changed = (yield* readUnit(target)) !== text;
    if (changed) yield* writeUnit(target, text);
    switch (target.platform) {
      case 'darwin':
        if (changed) {
          yield* rebootstrap(target, options);
        } else {
          yield* exec(['launchctl', 'kickstart', '-k', service(target)]);
        }
        return;
      case 'linux':
        if (changed) yield* exec(systemctl('daemon-reload'));
        yield* exec(systemctl('restart', SYSTEMD_UNIT));
        return;
      case 'win32':
        if (changed) {
          yield* recreateTask(target);
        } else {
          yield* exec(schtasks('/End', '/TN', SCHEDULED_TASK), true);
          yield* exec(schtasks('/Run', '/TN', SCHEDULED_TASK));
        }
        return;
    }
  });

/** Whether the unit file is present. */
export const serviceInstalled = (target: ServiceTarget) => Fs.use((fs) => fs.exists(unitPath(target)));

/** Stops the loaded job without deleting its unit, for recovery when IPC cannot shut it down. */
export const stopService = (target: ServiceTarget) => {
  switch (target.platform) {
    case 'darwin': return exec(['launchctl', 'bootout', service(target)], true);
    case 'linux': return exec(systemctl('stop', SYSTEMD_UNIT));
    case 'win32': return exec(schtasks('/End', '/TN', SCHEDULED_TASK), true);
  }
};
