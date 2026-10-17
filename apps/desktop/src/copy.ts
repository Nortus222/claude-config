import type { OperationChange, RunView } from '@nortuscc/agent/operations';

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

// Plurals of the leads `itemLabel` gives, for a group of items of one kind. A lead not listed reads the same
// for several items ("Claude instructions").
const PLURAL_LEADS: Readonly<Record<string, string>> = {
  'Claude setting': 'Claude settings', 'Codex setting': 'Codex settings', Setting: 'Settings',
  'Claude file': 'Claude files', 'Codex file': 'Codex files', File: 'Files', Skill: 'Skills', Integration: 'Integrations',
};
export type LabelGroup = { readonly heading: string | null; readonly items: readonly ItemLabel[] };
// Labels grouped by kind, in order of first appearance, so a kind's words appear once: "Claude settings" with
// names model and theme, "Skills from owner/repo" with tdd. A group of one, or a label with no name, has no
// heading and reads as its whole label.
export function groupLabels(labels: readonly ItemLabel[]): LabelGroup[] {
  const groups = new Map<string, ItemLabel[]>();
  labels.forEach((label, index) => {
    const key = label.name ? `${label.lead}\u0000${label.tail}` : `\u0001${index}`;
    groups.set(key, [...groups.get(key) ?? [], label]);
  });
  return [...groups.values()].map(items => {
    if (items.length === 1) return { heading: null, items };
    const { lead, tail } = items[0]!;
    // A file lead names its file in brackets ("Claude file (x)"); its group drops them.
    const kind = lead.replace(/\s*\(?\s*$/, '');
    return { heading: `${PLURAL_LEADS[kind] ?? kind}${tail.startsWith(')') ? tail.slice(1) : tail}`, items };
  });
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

// "3 changes", "1 change".
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// "Nortus222/claude-config" for a GitHub URL; other repositories keep their URL.
export const repoName = (url: string) => url.replace(/^(?:https:\/\/github\.com\/|git@github\.com:)/, '').replace(/\.git$/, '');
// "12.0 MB": a download size for people, never raw bytes.
export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
// What happened and what to do, for codes whose agent sentence is not meant for people.
const ERROR_TEXT: Readonly<Record<string, string>> = {
  NOT_SIGNED_IN: 'Not signed in to GitHub, or GitHub is unreachable. Sign in, then retry.',
  NO_REPORT: 'The agent hasn’t checked this Mac yet. Wait a moment, then reload.',
  MALFORMED: OFFLINE,
};
// The next step for codes whose agent sentence says what happened: shown after that sentence, or as part of
// the fallback when there is none.
const ACTION_TEXT: Readonly<Record<string, { readonly action: string; readonly fallback: string }>> = {
  UNAUTHORIZED: { action: 'Check that your GitHub account can push to it, then try again.',
    fallback: 'GitHub refused access to the repository. Check that your GitHub account can push to it, then try again.' },
};
// Text for a code whose own message is empty; otherwise the agent's sentence is shown.
const FALLBACK_TEXT: Readonly<Record<string, string>> = {
  // The agent refused a result over its size bound; the connection is fine.
  OVERSIZED: 'Too much to show at once.',
};
const UNKNOWN_ERROR = 'The agent stopped without saying why. Try again, and if it keeps happening use Reconnect agent in Settings.';
// The host prefixes the agent's refusal with its error code.
const CODE_PREFIX = /^([A-Z][A-Z0-9_]*): /;
// An agent sentence as one readable line: whitespace collapsed and long text cut.
const MAX_SENTENCE = 300;
const oneLine = (text: string) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > MAX_SENTENCE ? `${line.slice(0, MAX_SENTENCE - 1)}…` : line; };
const sentence = (text: string) => { const capital = text[0]!.toUpperCase() + text.slice(1); return /[.!?…]$/.test(capital) ? capital : `${capital}.`; };

// One sentence for an error: text chosen by its code when the app knows it, else the agent's own sentence
// without its code, else a fallback that names the next step.
export function errorText(error: unknown): string {
  const raw = typeof error === 'string' ? error
    : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : '';
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : CODE_PREFIX.exec(raw)?.[1];
  const known = code === undefined ? undefined : ERROR_TEXT[code];
  if (known) return known;
  const message = oneLine(raw.replace(CODE_PREFIX, ''));
  const action = code === undefined ? undefined : ACTION_TEXT[code];
  if (action) return message ? `${sentence(message)} ${action.action}` : action.fallback;
  return message || (code === undefined ? undefined : FALLBACK_TEXT[code]) || UNKNOWN_ERROR;
}

// Agent sentences that say only that a run stopped, in words that say so plainly.
const CAUSES: Readonly<Record<string, string>> = {
  'Operation stopped': 'It stopped before finishing, and the agent didn’t record why.',
  'Operation completion was not observed': 'The agent didn’t see it finish.',
  'Operation progress could not be saved': 'The agent couldn’t save its progress.',
};
// Why a run or step stopped, from the agent's record, without its "inspect before retrying": the view names
// the next step and where to look. A leading system code such as EACCES stays. '' when there is no reason.
export function causeText(message: string | undefined): string {
  const text = oneLine((message ?? '').replace(/;\s*inspect\b[^;]*$/i, ''));
  if (!text) return '';
  return CAUSES[text] ?? sentence(text);
}

// Why a run stopped, in the agent's words: its result's reason, then what the skill installer reported.
export function runCauses(run: Pick<RunView, 'result' | 'installation'>): string[] {
  const result = run.result;
  const reason = result && 'message' in result && result.status !== 'succeeded' ? causeText(result.message) : '';
  const installer = run.installation && run.installation.state !== 'verified' ? causeText(run.installation.message) : '';
  return [...new Set([reason, installer].filter(Boolean))];
}

// Where the agent keeps what a run leaves behind, as the owner finds them on disk.
export const AGENT_LOG = '~/.config/nortuscc/agent/agent.log';
export const backupFolder = (backupId: string) => `~/.config/nortuscc/backups/${backupId}`;

export type RunReport = {
  readonly title: string; readonly state: string; readonly cause: string; readonly runId: string;
  readonly failed: readonly { readonly label: string; readonly key: string; readonly note: string }[];
  readonly written: number; readonly notWritten: number | null; readonly backupIds: readonly string[];
};
// A plain-text account of a stopped run to paste into a message: what, why, which steps, and where to look.
export function runReport(report: RunReport): string {
  const lines = [`${report.title}: ${report.state}`];
  if (report.cause) lines.push(`Cause: ${report.cause}`);
  if (report.failed.length) lines.push('Failed steps:', ...report.failed.map(step => `- ${step.label} (${step.key})${step.note ? `: ${step.note}` : ''}`));
  lines.push(`Written: ${report.written}${report.notWritten === null ? '' : `, not written: ${report.notWritten}`}`);
  lines.push(`Run ID: ${report.runId}`);
  if (report.backupIds.length) lines.push(`Backups: ${report.backupIds.map(backupFolder).join(', ')}`);
  lines.push(`Agent log: ${AGENT_LOG}`);
  return lines.join('\n');
}
