import type { OperationChange } from '@nortuscc/agent/operations';

// Shared user-facing words, so no view shows raw keys, change kinds, ISO times or error codes.

// A label split around its name so views can emphasise it; `text` is the plain whole.
export type ItemLabel = { readonly lead: string; readonly name: string; readonly tail: string; readonly text: string };

const label = (lead: string, name = '', tail = ''): ItemLabel => ({ lead, name, tail, text: lead + name + tail });
const UNKNOWN = label('Item');

const AGENTS: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex' };
// Purposes of the files the base profile manages (`packages/profile-engine/src/files.json`).
const FILES: Readonly<Record<string, string>> = {
  'claude:CLAUDE.md': 'Claude instructions',
  'claude:settings.json': 'Claude settings',
  'codex:AGENTS.md': 'Codex instructions',
  'codex:config.toml': 'Codex configuration',
  'codex:models-static.json': 'Codex model list',
};

// Splits a file id `<agent>:<file>` into its agent's display name and file name.
const fileParts = (fileId: string) => {
  const at = fileId.indexOf(':');
  const agent = at > 0 ? AGENTS[fileId.slice(0, at)] : undefined;
  return { agent, file: agent ? fileId.slice(at + 1) : fileId };
};

// Labels a setup item id (`setting:<fileId>#<key>`, `file:<fileId>`, `skill:<source>/<name>`, `integration:<id>`).
export function itemLabel(key: string): ItemLabel {
  const colon = key.indexOf(':');
  const kind = key.slice(0, colon);
  const rest = colon === -1 ? '' : key.slice(colon + 1);
  if (!rest) return UNKNOWN;
  if (kind === 'setting') {
    const at = rest.indexOf('#');
    if (at <= 0 || at === rest.length - 1) return UNKNOWN;
    const { agent } = fileParts(rest.slice(0, at));
    return label(agent ? `${agent} setting ` : 'Setting ', rest.slice(at + 1));
  }
  if (kind === 'file') {
    const { agent, file } = fileParts(rest);
    return label(`${FILES[rest] ?? (agent ? `${agent} file` : 'File')} (`, file, ')');
  }
  if (kind === 'skill') {
    const at = rest.lastIndexOf('/');
    if (at === 0 || at === rest.length - 1) return UNKNOWN;
    return at > 0 ? label('Skill ', rest.slice(at + 1), ` from ${rest.slice(0, at)}`) : label('Skill ', rest);
  }
  if (kind === 'integration') return label('Integration ', rest);
  return UNKNOWN;
}

const CHANGE_TITLES = {
  setupApply: 'Apply incoming changes',
  followProfile: 'Follow profile',
  reconcile: 'Apply changes to this Mac',
  machineIntent: 'Save skill choice',
  update: 'Update skills',
  addSkill: 'Add a skill',
  uninstallConfig: 'Restore configuration',
  capture: 'Save this Mac’s changes to a draft',
  syncDecision: 'Decide on an incoming change',
  editDraft: 'Save draft',
  removeDraftIntent: 'Remove a draft change',
  deleteDraft: 'Delete draft',
  publishDraft: 'Publish draft',
  announcePublication: 'Announce publication',
  ghLogin: 'Sign in to GitHub',
  sourceDecision: 'Pin or ignore a skill source',
  setPolicy: 'Change automatic apply',
  resume: 'Resume automatic apply',
  signIn: 'Sign in',
  signOut: 'Sign out',
  syncAccount: 'Sync account',
  patchMachineMetadata: 'Update this Mac’s details',
  pruneBackups: 'Remove old backups',
} as const satisfies Record<OperationChange['kind'], string>;

// The title of a run or preview of one change kind.
export const changeTitle = (kind: OperationChange['kind']): string => CHANGE_TITLES[kind];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

// How long ago `iso` was, relative to `now`; a short date after a week, '' when unreadable.
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const elapsed = now.getTime() - then.getTime();
  if (Number.isNaN(elapsed)) return '';
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return count(Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return count(Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 7 * DAY) return count(Math.floor(elapsed / DAY), 'day');
  const sameYear = then.getFullYear() === now.getFullYear();
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

const OFFLINE = 'Lost the connection to the agent. Reconnect the agent.';
const ERROR_TEXT: Readonly<Record<string, string>> = {
  NOT_SIGNED_IN: 'Not signed in to GitHub, or GitHub is unreachable. Sign in, then retry.',
  UNAUTHORIZED: 'Access was refused. Check your permissions, then retry.',
  NO_REPORT: 'Waiting for the agent’s first inspection.',
  MALFORMED: OFFLINE,
  // An operation refused a result over its size bound; the connection is fine.
  OVERSIZED: 'Too much to show at once. Select fewer items.',
};
// The host prefixes the agent's refusal with its error code.
const CODE_PREFIX = /^([A-Z][A-Z0-9_]*): /;

// One sentence for an error: text chosen by its code when the app knows it, else its message without the code.
export function errorText(error: unknown): string {
  const raw = typeof error === 'string' ? error
    : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : '';
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : CODE_PREFIX.exec(raw)?.[1];
  const known = code === undefined ? undefined : ERROR_TEXT[code];
  return known ?? (raw.replace(CODE_PREFIX, '').trim() || 'Something went wrong.');
}
