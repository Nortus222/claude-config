import { Cause } from 'effect';
import { redactSecretValues, settingsComplaints } from '@nortuscc/profile-engine';

// Public owner identities are exact, bounded, and subject to the setting owner's secret checks.
export const safeOwnerString = (value: string): boolean => value.length > 0 && [...value].length <= 500 && !settingsComplaints({ value }).length;

// Why something failed, in its own words: an Error's message, else its `_tag`.
export const describe = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && '_tag' in error && typeof error._tag === 'string') return error._tag;
  return String(error);
};

// A name that says its value is a credential, in a query string, an environment assignment or JSON.
const SECRET_NAME = String.raw`[\w.-]*?(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|signature)`;

// Credentials an agent diagnostic may carry beyond the setting owner's shapes, each with what of the
// match to keep: tokens by prefix, authorization headers, credential-named assignments and URL
// user-info (up to the last `@` before the host, since a password may hold one), and GitHub device codes.
const AGENT_SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bnmt_[A-Za-z0-9_-]+/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]+/g, '[redacted]'],
  [/\bglpat-[A-Za-z0-9_-]+/g, '[redacted]'],
  [/\bxox[a-z]-[A-Za-z0-9-]+/g, '[redacted]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\b(authorization\s*[:=]\s*)(?:(?:basic|bearer|token|digest)\s+)?[^\s,;]+/gi, '$1[redacted]'],
  [/\bBearer\s+\S+/gi, '[redacted]'],
  [new RegExp(String.raw`("${SECRET_NAME}"\s*:\s*)"[^"]*"`, 'gi'), '$1"[redacted]"'],
  [new RegExp(String.raw`\b(${SECRET_NAME}=)(?:"[^"]*"|'[^']*'|[^\s&#'"]+)`, 'gi'), '$1[redacted]'],
  [/(?<=:\/\/)[^/\s?#]*@/g, '[redacted]'],
  [/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, '[redacted]'],
];

// Text safe to persist, send or log: credential-shaped values redacted, on one line. Paths,
// errno reasons and exit codes stay.
export const redact = (text: string): string =>
  AGENT_SECRETS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), redactSecretValues(text)).replace(/\s+/g, ' ').trim();

const bounded = (line: string, limit: number): string => {
  const points = [...line];
  return points.length <= limit ? line : `${points.slice(0, limit - 1).join('')}…`;
};

// A redacted failure sentence of at most `limit` code points.
export const safeMessage = (text: string, limit = 500): string => {
  const line = redact(text) || 'Unknown failure';
  return bounded(line[0]!.toUpperCase() + line.slice(1), limit);
};

// A step note as safeMessage makes a failure sentence, but in its own case (callers quote it mid-sentence)
// and empty when it says nothing.
export const safeNote = (note: string, limit = 500): string => bounded(redact(note), limit);

// The safe message of a failed Effect's cause.
export const causeMessage = (cause: Cause.Cause<unknown>, limit?: number): string => safeMessage(describe(Cause.squash(cause)), limit);

// "Couldn't apply <key>: <note>" for the first failed step, naming how many more failed.
export const failedStepsMessage = (steps: ReadonlyArray<{ readonly key: string; readonly outcome: string; readonly note: string }>): string | undefined => {
  const failed = steps.filter(step => step.outcome === 'failed');
  if (!failed.length) return undefined;
  const more = failed.length > 1 ? ` (${failed.length - 1} more step${failed.length > 2 ? 's' : ''} failed)` : '';
  return safeMessage(`Couldn't apply ${failed[0]!.key}: ${[...(redact(failed[0]!.note) || 'no reason was reported')].slice(0, 400).join('')}${more}`);
};
