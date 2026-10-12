import { performance } from 'node:perf_hooks';

export const STARTUP_PREFIX = '[nortuscc-startup] ';
export const STARTUP_PHASES = ['entry', 'runtime_metadata', 'login_probe', 'shell_spawn', 'shell_ready', 'environment_ready', 'probe_cleanup', 'paths', 'lifecycle', 'lock', 'log_rotation', 'services', 'scheduler', 'session', 'ipc', 'running', 'shutdown', 'ipc_closed', 'stopped', 'app_setup', 'updater_source', 'preferences_paths', 'maintenance_state', 'setup_state', 'helper', 'ready_wait', 'runtime_identity'] as const;
export type StartupPhase = typeof STARTUP_PHASES[number];
export type StartupStatus = 'started' | 'completed' | 'failed' | 'timed_out' | 'fallback' | 'cancelled';
export type StartupOperation = 'app_startup' | 'foreground' | 'ensure' | 'restart' | 'paths' | 'setup_state' | 'bootstrap' | 'install_git' | 'prepare_update' | 'recover_update' | 'maintenance_state' | 'invalid';
export type StartupDiagnostics = { readonly record: (phase: StartupPhase, status: StartupStatus) => void };
type Options = {
  readonly component: 'native' | 'helper' | 'agent';
  readonly operation: StartupOperation;
  readonly write: (line: string) => void;
  readonly clock?: { readonly monotonic: () => number; readonly wall: () => number };
};
const statuses = new Set(['started', 'completed', 'failed', 'timed_out', 'fallback', 'cancelled']);
const phases = new Set<string>(STARTUP_PHASES);
const operations = new Set(['app_startup', 'foreground', 'ensure', 'restart', 'paths', 'setup_state', 'bootstrap', 'install_git', 'prepare_update', 'recover_update', 'maintenance_state', 'invalid']);
const validNumber = (value: number) => Number.isSafeInteger(value) && value >= 0;

// Fixed metadata only; diagnostics must never interfere with startup or carry captured output.
export const startupDiagnostics = (options: Options): StartupDiagnostics => {
  const clock = options.clock ?? { monotonic: () => performance.now(), wall: () => Date.now() };
  const beginnings = new Map<StartupPhase, number>();
  let origin = 0;
  let startedAt = 0;
  let enabled = false;
  let seq = 0;
  try {
    origin = clock.monotonic();
    startedAt = clock.wall();
    enabled = Number.isFinite(origin) && validNumber(startedAt) && ['native', 'helper', 'agent'].includes(options.component) && operations.has(options.operation);
  } catch {}
  return { record: (phase, status) => {
    try {
      if (!enabled || !phases.has(phase) || !statuses.has(status)) return;
      const elapsedMs = Math.max(0, Math.round(clock.monotonic() - origin));
      if (!validNumber(elapsedMs) || seq >= Number.MAX_SAFE_INTEGER) return;
      const beginning = beginnings.get(phase);
      const durationMs = status === 'started' || beginning === undefined ? undefined : Math.max(0, elapsedMs - beginning);
      if (status === 'started') beginnings.set(phase, elapsedMs);
      else beginnings.delete(phase);
      options.write(STARTUP_PREFIX + JSON.stringify({ v: 1, component: options.component, pid: process.pid, startedAt,
        seq: ++seq, elapsedMs, phase, status, operation: options.operation, ...(durationMs === undefined ? {} : { durationMs }) }) + '\n');
    } catch {}
  } };
};
