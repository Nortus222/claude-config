import { basename, join } from 'node:path';
import { Effect } from 'effect';
import { Backups } from '../backups.ts';
import type { FsFailed } from '../errors.ts';
import { Fs } from '../fs.ts';
import type { StepResult } from '../model.ts';
import type { Declaration, Inspected } from './declaration.ts';

type Settings = Record<string, unknown>;
type Read = { readonly settings: Settings; readonly existed: boolean } | { readonly corrupt: true };

const isPlainObject = (value: unknown): value is Settings =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// The hook runs from a nortuscc-owned copy under the Claude directory, so moving the clone cannot break it.
export const hookPaths = (claudeDir: string, d: Declaration) => ({
  settings: join(claudeDir, 'settings.json'),
  installed: join(claudeDir, 'hooks', basename(d.file!)),
});

export const hookCommand = (claudeDir: string, d: Declaration): string => `node ${hookPaths(claudeDir, d).installed}`;

export const describeHook = (claudeDir: string, d: Declaration): string =>
  `register ${d.event} hook -> ${hookPaths(claudeDir, d).installed}`;

// "No settings yet" is a bare machine; "cannot parse" is the user's file, never ours to replace.
const readSettings = (path: string): Effect.Effect<Read, FsFailed, Fs> =>
  Fs.use((fs) => fs.readText(path)).pipe(
    Effect.map((text): Read => {
      if (text === undefined) return { settings: {}, existed: false };
      try {
        const parsed: unknown = JSON.parse(text);
        return isPlainObject(parsed) ? { settings: parsed, existed: true } : { corrupt: true };
      } catch {
        return { corrupt: true };
      }
    }),
  );

const registrations = (settings: Settings, event: string): unknown[] => {
  const forEvent = isPlainObject(settings.hooks) ? settings.hooks[event] : undefined;
  return Array.isArray(forEvent) ? forEvent : [];
};

const registered = (settings: Settings, event: string, command: string) =>
  registrations(settings, event).some((group) =>
    isPlainObject(group) && Array.isArray(group.hooks) && group.hooks.some((hook) => isPlainObject(hook) && hook.command === command));

const CORRUPT = 'local settings.json could not be parsed';

export const inspectHook = (claudeDir: string, d: Declaration): Effect.Effect<Inspected, never, Fs> =>
  Effect.gen(function* () {
    const { settings, installed } = hookPaths(claudeDir, d);
    const read = yield* readSettings(settings);
    if ('corrupt' in read) return { state: 'blocked' as const, note: CORRUPT };
    const present = yield* Fs.use((fs) => fs.exists(installed));
    return present && registered(read.settings, d.event!, hookCommand(claudeDir, d))
      ? { state: 'installed' as const, note: 'already registered' }
      : { state: 'missing' as const, note: '' };
  }).pipe(Effect.catchTag('FsFailed', (err) => Effect.succeed<Inspected>({ state: 'blocked', note: err.message })));

// Adds only the declared registration, only when absent; never replaces the document or removes another hook.
// The file lands first, so a registration never points at a hook that is not there yet.
export const installHook = (
  paths: { readonly repo: string; readonly claude: string },
  d: Declaration,
): Effect.Effect<StepResult, FsFailed, Fs | Backups> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const { settings: path, installed } = hookPaths(paths.claude, d);
    const read = yield* readSettings(path);
    if ('corrupt' in read) return { ok: false, note: `${CORRUPT}; left it untouched (${path})` };

    yield* fs.copy(join(paths.repo, d.file!), installed);
    const command = hookCommand(paths.claude, d);
    if (registered(read.settings, d.event!, command)) return { ok: true, note: 'already registered' };

    if (read.existed) yield* (yield* Backups).preserve(path, 'settings.json', 'claude');
    const hooks = isPlainObject(read.settings.hooks) ? read.settings.hooks : {};
    const next = {
      ...read.settings,
      hooks: { ...hooks, [d.event!]: [...registrations(read.settings, d.event!), { hooks: [{ type: 'command', command }] }] },
    };
    yield* fs.writeTextAtomic(path, JSON.stringify(next, null, 2) + '\n');
    return { ok: true, note: `registered ${d.event}` };
  });
