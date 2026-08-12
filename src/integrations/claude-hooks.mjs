import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { claudeDir as realClaudeDir, repoRoot as realRepoRoot } from '../resolve.mjs';
import { preserveCopy } from '../backup.mjs';

// Selected hook files are installed into a nortuscc-owned location under the
// Claude directory, and the registration points there. Registering the repo
// path instead would break the moment the clone moves or a worktree is removed.
export function hooksDirOf(deps) {
  const claude = (deps.claudeDir ?? realClaudeDir)();
  return join(claude, 'hooks');
}

export function installedHookPath(item, deps) {
  return join(hooksDirOf(deps), basename(item.file));
}

export function hookCommand(item, deps) {
  return `node ${installedHookPath(item, deps)}`;
}

function settingsPathOf(deps) {
  return deps.settingsPath ?? join((deps.claudeDir ?? realClaudeDir)(), 'settings.json');
}

// Distinguishes "no settings yet" (a bare machine, fine to create) from
// "settings that cannot be parsed" (the user's file, mid-edit or hand-broken —
// never ours to replace).
function readSettings(path) {
  if (!existsSync(path)) return { settings: {}, existed: false, corrupt: false };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { settings: null, existed: true, corrupt: true };
    }
    return { settings: parsed, existed: true, corrupt: false };
  } catch {
    return { settings: null, existed: true, corrupt: true };
  }
}

function registrations(settings, event) {
  const hooks = settings.hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  const forEvent = hooks[event];
  return Array.isArray(forEvent) ? forEvent : [];
}

function alreadyRegistered(settings, item, command) {
  return registrations(settings, item.event).some((group) =>
    (group?.hooks ?? []).some((hook) => hook?.command === command),
  );
}

export function inspectHook(item, deps = {}) {
  const { settings, corrupt } = readSettings(settingsPathOf(deps));
  if (corrupt) return { state: 'blocked', note: 'local settings.json could not be parsed' };

  const installed = existsSync(installedHookPath(item, deps));
  return installed && alreadyRegistered(settings, item, hookCommand(item, deps))
    ? { state: 'installed', note: 'already registered' }
    : { state: 'missing', note: '' };
}

export function describeHook(item, deps = {}) {
  return `register ${item.event} hook -> ${installedHookPath(item, deps)}`;
}

// Adds only the declared registration, and only if it is absent. It never
// replaces the whole document and never removes an unselected pre-existing
// hook: permissions, preferences, plugins and other people's hooks are the
// user's, and copying a whole settings.json over them is precisely what this
// design retires.
export async function installHook(item, deps = {}) {
  const path = settingsPathOf(deps);
  const { settings, existed, corrupt } = readSettings(path);
  if (corrupt) {
    return { ok: false, note: `local settings.json could not be parsed; left it untouched (${path})` };
  }

  const command = hookCommand(item, deps);

  // Install the file first, so a settings entry never points at a hook that is
  // not there yet.
  const repo = (deps.repo ?? realRepoRoot)();
  mkdirSync(hooksDirOf(deps), { recursive: true });
  copyFileSync(join(repo, item.file), installedHookPath(item, deps));

  if (alreadyRegistered(settings, item, command)) {
    return { ok: true, note: 'already registered' };
  }

  // Back up before the first byte changes. Nothing to preserve on a machine
  // that has no settings file yet.
  const preserve = deps.preserve ?? ((abs) => preserveCopy(abs, 'settings.json', 'claude'));
  if (existed) preserve(path);

  const next = { ...settings };
  next.hooks = { ...(typeof next.hooks === 'object' && !Array.isArray(next.hooks) ? next.hooks : {}) };
  const existing = registrations(next, item.event);
  next.hooks[item.event] = [...existing, { hooks: [{ type: 'command', command }] }];

  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { ok: true, note: `registered ${item.event}` };
}

export function claudeHookAdapter(deps = {}) {
  return {
    inspect: (item) => inspectHook(item, deps),
    describe: (item) => describeHook(item, deps),
    install: (item) => installHook(item, deps),
  };
}
