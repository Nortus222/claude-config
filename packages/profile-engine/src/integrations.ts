import { CATEGORIES, TARGETS } from './model.ts';
import type { Allow, Integration, Issue } from './model.ts';
import { isPlainObject, issue, parseJson } from './issues.ts';
import { looksLikeSecretName, looksLikeSecretValue } from './secrets.ts';

export const INTEGRATIONS_SOURCE = 'integrations.json';

const TYPES = ['hook', 'marketplace', 'plugin', 'mcp'];
const VERSION = 1;
// Lists of names rather than data, so never scanned as if they held one.
const NAME_LIST_FIELDS = new Set(['requiresEnv']);

type Parsed = { integrations: Integration[]; allow: Allow; issues: Issue[] };

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function secretComplaints(item: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [field, value] of Object.entries(item)) {
    if (NAME_LIST_FIELDS.has(field)) continue;
    if (looksLikeSecretName(field)) {
      errors.push(
        `integration '${item.id}': field '${field}' looks like a secret; ` +
          'commit the name of an environment variable in requiresEnv instead',
      );
      continue;
    }
    const strings = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    for (const text of strings) {
      if (typeof text !== 'string') continue;
      if (looksLikeSecretValue(text)) {
        errors.push(
          `integration '${item.id}': field '${field}' contains what looks like a secret value; ` +
            'commit the name of an environment variable in requiresEnv instead',
        );
        break;
      }
    }
  }
  return errors;
}

function validateOne(item: unknown, index: number, seen: Set<string>, hookFileExists: (file: string) => boolean): string[] {
  if (!isPlainObject(item)) return [`integration #${index + 1}: must be an object`];
  const errors: string[] = [];
  const where = item.id ? `integration '${item.id}'` : `integration #${index + 1}`;

  if (!isText(item.id)) errors.push(`${where}: needs a stable string id`);
  else if (seen.has(item.id)) errors.push(`duplicate integration id '${item.id}'`);
  else seen.add(item.id);

  if (!isText(item.label)) errors.push(`${where}: needs a user-facing label`);
  if (!(TARGETS as ReadonlyArray<unknown>).includes(item.target)) errors.push(`${where}: unsupported target '${item.target}'`);
  if (!TYPES.includes(item.type as string)) errors.push(`${where}: unknown type '${item.type}'`);
  if (typeof item.default !== 'boolean') errors.push(`${where}: 'default' must be true or false`);

  if (item.type === 'plugin' && !isText(item.plugin)) errors.push(`${where}: a plugin needs a 'plugin' name`);
  if (item.type === 'marketplace') {
    if (!isText(item.marketplace)) errors.push(`${where}: a marketplace needs a 'marketplace' source`);
    if (!isText(item.name)) {
      errors.push(`${where}: a marketplace needs the 'name' it registers as (not derivable from the source)`);
    }
  }
  if (item.type === 'mcp' && !isText(item.command)) errors.push(`${where}: an mcp server needs a 'command'`);
  if (item.type === 'hook') {
    if (!isText(item.event)) errors.push(`${where}: a hook needs an 'event'`);
    if (!isText(item.file)) errors.push(`${where}: a hook needs a 'file' this repo ships`);
    else if (!hookFileExists(item.file)) errors.push(`${where}: referenced file '${item.file}' is not in the repo`);
  }

  if (item.requiresEnv !== undefined) {
    if (!Array.isArray(item.requiresEnv) || item.requiresEnv.some((n) => typeof n !== 'string')) {
      errors.push(`${where}: 'requiresEnv' must be a list of environment-variable names`);
    }
  }

  errors.push(...secretComplaints(item));
  return errors;
}

function validateAllow(value: unknown, errors: string[]): Allow {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    errors.push("integrations.json: 'allow' must be an object keyed by category");
    return {};
  }
  const allow: Record<string, ReadonlyArray<string>> = {};
  for (const [category, ids] of Object.entries(value)) {
    if (!(CATEGORIES as ReadonlyArray<string>).includes(category)) {
      errors.push(
        `integrations.json: 'allow' names unknown category '${category}'; ` +
          `expected one of ${CATEGORIES.join(', ')}`,
      );
      continue;
    }
    if (!Array.isArray(ids) || ids.some((id) => !isText(id))) {
      errors.push(`integrations.json: 'allow.${category}' must be a list of ids`);
      continue;
    }
    allow[category] = ids;
  }
  return allow;
}

// Installable integrations with the CLI's meaning. A document with any error yields no
// integrations and no allow list: honouring half of a refused declaration is how it would still
// reach an installer. `hookFileExists` answers whether a repo-relative hook file is shipped.
export function parseIntegrations(text: string | undefined, hookFileExists: (file: string) => boolean): Parsed {
  if (text === undefined) return { integrations: [], allow: {}, issues: [] };
  const refuse = (messages: string[]): Parsed => ({
    integrations: [],
    allow: {},
    issues: messages.map((m) => issue('base', INTEGRATIONS_SOURCE, '', m)),
  });

  const parsed = parseJson(text, 'base', INTEGRATIONS_SOURCE);
  if (!parsed.ok) return { integrations: [], allow: {}, issues: [parsed.issue] };
  const value = parsed.value;
  if (!isPlainObject(value)) return refuse(['integrations.json must be a JSON object']);

  const errors: string[] = [];
  if (value.version !== VERSION) {
    errors.push(`integrations.json version must be ${VERSION}, found ${JSON.stringify(value.version)}`);
  }
  const allow = validateAllow(value.allow, errors);
  if (!Array.isArray(value.integrations)) return refuse([...errors, "integrations.json needs an 'integrations' array"]);

  const seen = new Set<string>();
  value.integrations.forEach((item, index) => errors.push(...validateOne(item, index, seen, hookFileExists)));

  if (errors.length) return refuse(errors);
  return { integrations: value.integrations as Integration[], allow, issues: [] };
}

// The repo-relative hook files a document references, so a loader can check them before validating.
export function referencedFiles(text: string | undefined): string[] {
  if (text === undefined) return [];
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value) || !Array.isArray(value.integrations)) return [];
    return value.integrations
      .filter((item): item is Record<string, unknown> => isPlainObject(item) && item.type === 'hook' && isText(item.file))
      .map((item) => item.file as string);
  } catch {
    return [];
  }
}
