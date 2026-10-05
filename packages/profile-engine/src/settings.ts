import type { Issue, Settings } from './model.ts';
import { isPlainObject, issue, parseJson } from './issues.ts';
import { nestedSecretComplaints } from './secrets.ts';

// The CLI's rules for a merge-keys document: an object naming at least one key, with no
// credential anywhere inside it.
export function settingsComplaints(value: unknown): string[] {
  if (!isPlainObject(value)) return ['settings.keys.json must be a JSON object'];
  const errors: string[] = [];
  if (Object.keys(value).length === 0) {
    errors.push('settings.keys.json names no keys; remove the manifest entry instead');
  }
  errors.push(...nestedSecretComplaints(value, ''));
  return errors;
}

// The keys a merge-keys document owns and their values. Its key set is the allowlist of keys the
// engine may write. Absent owns nothing; a refused document owns nothing and reports why.
export function parseSettingsKeys(
  text: string | undefined,
  source: string,
): { value: Settings | undefined; issues: Issue[] } {
  if (text === undefined) return { value: undefined, issues: [] };
  const parsed = parseJson(text, 'base', source);
  if (!parsed.ok) return { value: undefined, issues: [parsed.issue] };

  const errors = settingsComplaints(parsed.value);
  if (errors.length) return { value: undefined, issues: errors.map((m) => issue('base', source, '', m)) };
  return { value: parsed.value as Settings, issues: [] };
}
