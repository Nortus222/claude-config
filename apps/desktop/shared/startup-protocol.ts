import { isAbsolute } from 'node:path';
import { decodePrepareUpdate, type MaintenanceState } from './maintenance-protocol.ts';
import { decodeSetupState, type SetupState } from './setup-protocol.ts';

export type StartupOutcome = 'needs_setup' | 'ready' | 'recovered' | 'setup_failed' | 'runtime_failed'
  | 'maintenance_failed' | 'ensure_failed' | 'recovery_failed';
export type StartupContext = { stateRoot: string; setup: SetupState | null; maintenance: MaintenanceState | null; outcome: StartupOutcome };
const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw new Error('invalid startup record');
  return value as Record<string, unknown>;
};
const path = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && !/\p{Cc}/u.test(value);
const decodeMaintenance = (value: unknown): MaintenanceState => {
  const raw = record(value, ['pending', 'phase', 'fromVersion', 'toVersion', 'backupPath', 'diagnostic']);
  if (raw.pending === false && ['phase', 'fromVersion', 'toVersion', 'backupPath', 'diagnostic'].every(key => raw[key] === null)) {
    return { pending: false, phase: null, fromVersion: null, toVersion: null, backupPath: null, diagnostic: null };
  }
  if (raw.pending !== true) throw new Error('invalid startup maintenance');
  if (raw.diagnostic === 'Pending update journal is invalid; manual recovery is required.'
    && ['phase', 'fromVersion', 'toVersion', 'backupPath'].every(key => raw[key] === null)) {
    return { pending: true, phase: null, fromVersion: null, toVersion: null, backupPath: null, diagnostic: raw.diagnostic };
  }
  if (!['prepared', 'installing', 'awaiting-health'].includes(raw.phase as string) || raw.diagnostic !== null || !path(raw.backupPath)) throw new Error('invalid startup maintenance');
  const versions = decodePrepareUpdate({ fromVersion: raw.fromVersion, toVersion: raw.toVersion });
  return { pending: true, phase: raw.phase as MaintenanceState['phase'], ...versions, backupPath: raw.backupPath, diagnostic: null };
};

// Only a complete fixed helper context can authorize native startup and preference identity.
export const decodeStartupContext = (value: unknown): StartupContext => {
  const raw = record(value, ['stateRoot', 'setup', 'maintenance', 'outcome']);
  if (!path(raw.stateRoot)) throw new Error('invalid startup state root');
  const setup = raw.setup === null ? null : decodeSetupState(raw.setup);
  if (setup && (setup.needsSetup ? setup.repo !== null : !path(setup.repo))) throw new Error('invalid startup setup');
  const maintenance = raw.maintenance === null ? null : decodeMaintenance(raw.maintenance);
  const outcome = raw.outcome;
  const valid = outcome === 'setup_failed' ? setup === null && maintenance === null
    : outcome === 'runtime_failed' || outcome === 'maintenance_failed' ? setup !== null && maintenance === null
    : outcome === 'needs_setup' ? setup?.needsSetup === true && maintenance !== null
    : outcome === 'ready' || outcome === 'ensure_failed' ? setup?.needsSetup === false && maintenance?.pending === false
    : outcome === 'recovered' || outcome === 'recovery_failed' ? setup?.needsSetup === false && maintenance?.pending === true
    : false;
  if (!valid) throw new Error('invalid startup outcome');
  return { stateRoot: raw.stateRoot, setup, maintenance, outcome: outcome as StartupOutcome };
};
