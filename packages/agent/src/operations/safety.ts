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

// Credentials an agent diagnostic may carry beyond the setting owner's shapes: hosted machine
// tokens, bearer headers, URL user-info and GitHub device codes.
const AGENT_SECRETS = [/\bnmt_[A-Za-z0-9_-]+/g, /\bBearer\s+\S+/gi, /(?<=:\/\/)[^/\s@]+@/g, /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g];

// Text safe to persist, send or log: credential-shaped values redacted, on one line. Paths,
// errno reasons and exit codes stay.
export const redact = (text: string): string =>
  AGENT_SECRETS.reduce((out, pattern) => out.replace(pattern, '[redacted]'), redactSecretValues(text)).replace(/\s+/g, ' ').trim();

// A redacted failure sentence of at most `limit` code points.
export const safeMessage = (text: string, limit = 500): string => {
  const line = redact(text) || 'Unknown failure';
  const points = [...(line[0]!.toUpperCase() + line.slice(1))];
  return points.length <= limit ? points.join('') : `${points.slice(0, limit - 1).join('')}…`;
};

// The safe message of a failed Effect's cause.
export const causeMessage = (cause: Cause.Cause<unknown>, limit?: number): string => safeMessage(describe(Cause.squash(cause)), limit);

// "Couldn't apply <key>: <note>" for the first failed step, naming how many more failed.
export const failedStepsMessage = (steps: ReadonlyArray<{ readonly key: string; readonly outcome: string; readonly note: string }>): string | undefined => {
  const failed = steps.filter(step => step.outcome === 'failed');
  if (!failed.length) return undefined;
  const more = failed.length > 1 ? ` (${failed.length - 1} more step${failed.length > 2 ? 's' : ''} failed)` : '';
  return safeMessage(`Couldn't apply ${failed[0]!.key}: ${[...(redact(failed[0]!.note) || 'no reason was reported')].slice(0, 400).join('')}${more}`);
};
