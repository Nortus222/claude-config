const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw new Error('invalid maintenance record');
  return value as Record<string, unknown>;
};
export const stableVersion = (value: unknown): string => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    || !value.split('.').every(part => Number.isSafeInteger(Number(part)))) throw new Error('maintenance requires a stable version');
  return value;
};
export const decodePrepareUpdate = (value: unknown): { fromVersion: string; toVersion: string } => {
  const raw = record(value, ['fromVersion', 'toVersion']);
  const fromVersion = stableVersion(raw.fromVersion), toVersion = stableVersion(raw.toVersion);
  const oldParts = fromVersion.split('.').map(Number), newParts = toVersion.split('.').map(Number);
  const first = oldParts.findIndex((part, index) => part !== newParts[index]);
  if (first < 0 || newParts[first]! <= oldParts[first]!) throw new Error('update version must increase');
  return { fromVersion, toVersion };
};
export const validInstallerPid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
export type MaintenanceAction = { action: 'begin-install'; installerPid: number } | { action: 'commit' | 'abort' };
export const decodeMaintenanceAction = (value: unknown): MaintenanceAction => {
  const action = typeof value === 'object' && value !== null && 'action' in value ? value.action : undefined;
  if (action === 'begin-install') {
    const raw = record(value, ['action', 'installerPid']);
    if (!validInstallerPid(raw.installerPid)) throw new Error('invalid native installer PID');
    return { action, installerPid: raw.installerPid };
  }
  const raw = record(value, ['action']);
  if (raw.action !== 'commit' && raw.action !== 'abort') throw new Error('invalid maintenance action');
  return { action: raw.action };
};

export const decodeRecoverUpdate = (value: unknown): { appVersion: string } => {
  const raw = record(value, ['appVersion']); return { appVersion: stableVersion(raw.appVersion) };
};
export type MaintenanceState = { pending: boolean; phase: 'prepared' | 'installing' | 'awaiting-health' | null;
  fromVersion: string | null; toVersion: string | null; backupPath: string | null; diagnostic: string | null };
