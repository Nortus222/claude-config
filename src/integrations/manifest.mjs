import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../resolve.mjs';
import { TARGETS } from '../targets.mjs';
import { OBSERVED_CATEGORIES } from '../inventory.mjs';
import { looksLikeSecretName, looksLikeSecretValue } from '../secrets.mjs';

export const TYPES = ['hook', 'marketplace', 'plugin', 'mcp'];

const VERSION = 1;

// Values that are lists of names rather than data, and so are never scanned as
// if they held one.
const NAME_LIST_FIELDS = new Set(['requiresEnv']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function secretComplaints(item) {
  const errors = [];
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

function validateOne(item, index, { repo, seen }) {
  const errors = [];
  const where = isPlainObject(item) && item.id ? `integration '${item.id}'` : `integration #${index + 1}`;

  if (!isPlainObject(item)) return [`${where}: must be an object`];

  if (typeof item.id !== 'string' || !item.id) errors.push(`${where}: needs a stable string id`);
  else if (seen.has(item.id)) errors.push(`duplicate integration id '${item.id}'`);
  else seen.add(item.id);

  if (typeof item.label !== 'string' || !item.label) errors.push(`${where}: needs a user-facing label`);
  if (!TARGETS.includes(item.target)) errors.push(`${where}: unsupported target '${item.target}'`);
  if (!TYPES.includes(item.type)) errors.push(`${where}: unknown type '${item.type}'`);
  if (typeof item.default !== 'boolean') errors.push(`${where}: 'default' must be true or false`);

  // Type-specific source metadata. Without it an adapter would spawn an
  // installer with an undefined argument.
  if (item.type === 'plugin' && (typeof item.plugin !== 'string' || !item.plugin)) {
    errors.push(`${where}: a plugin needs a 'plugin' name`);
  }
  if (item.type === 'marketplace') {
    if (typeof item.marketplace !== 'string' || !item.marketplace) {
      errors.push(`${where}: a marketplace needs a 'marketplace' source`);
    }
    // The registered name comes from the marketplace's own manifest and cannot
    // be derived from the source — `mksglu/context-mode` registers as
    // `context-mode`, `thedotmack/claude-mem` as `thedotmack`. Guessing meant
    // inspection never matched and the marketplace was re-added every run, so
    // it has to be stated.
    if (typeof item.name !== 'string' || !item.name) {
      errors.push(`${where}: a marketplace needs the 'name' it registers as (not derivable from the source)`);
    }
  }
  if (item.type === 'mcp' && (typeof item.command !== 'string' || !item.command)) {
    errors.push(`${where}: an mcp server needs a 'command'`);
  }
  if (item.type === 'hook') {
    if (typeof item.event !== 'string' || !item.event) errors.push(`${where}: a hook needs an 'event'`);
    if (typeof item.file !== 'string' || !item.file) {
      errors.push(`${where}: a hook needs a 'file' this repo ships`);
    } else if (!existsSync(join(repo, item.file))) {
      // Caught here rather than at install time, where the result is a
      // registration pointing at nothing and a hook that fails every session.
      errors.push(`${where}: referenced file '${item.file}' is not in the repo`);
    }
  }

  if (item.requiresEnv !== undefined) {
    if (!Array.isArray(item.requiresEnv) || item.requiresEnv.some((n) => typeof n !== 'string')) {
      errors.push(`${where}: 'requiresEnv' must be a list of environment-variable names`);
    }
  }

  errors.push(...secretComplaints(item));
  return errors;
}

// Extras that are present on purpose. Ids only — the same "may name environment
// variables, never their values" convention the rest of this file keeps.
function validateAllow(value, errors) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    errors.push("integrations.json: 'allow' must be an object keyed by category");
    return {};
  }

  const allow = {};
  for (const [category, ids] of Object.entries(value)) {
    if (!OBSERVED_CATEGORIES.includes(category)) {
      errors.push(
        `integrations.json: 'allow' names unknown category '${category}'; ` +
          `expected one of ${OBSERVED_CATEGORIES.join(', ')}`,
      );
      continue;
    }
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) {
      errors.push(`integrations.json: 'allow.${category}' must be a list of ids`);
      continue;
    }
    allow[category] = ids;
  }
  return allow;
}

// Validation runs before any adapter is called, and a manifest with any error
// yields no integrations at all: installing "most of" a manifest the validator
// refused is how a rejected declaration still reaches a child process.
export function validateIntegrations(value, { repo } = {}) {
  const errors = [];

  if (!isPlainObject(value)) {
    return { integrations: [], allow: {}, errors: ['integrations.json must be a JSON object'] };
  }
  if (value.version !== VERSION) {
    errors.push(`integrations.json version must be ${VERSION}, found ${JSON.stringify(value.version)}`);
  }

  const allow = validateAllow(value.allow, errors);

  if (!Array.isArray(value.integrations)) {
    return { integrations: [], allow: {}, errors: [...errors, "integrations.json needs an 'integrations' array"] };
  }

  const seen = new Set();
  value.integrations.forEach((item, index) => {
    errors.push(...validateOne(item, index, { repo, seen }));
  });

  // An invalid manifest yields no allow list either: honouring exceptions from
  // a document the validator refused would be trusting half of it.
  if (errors.length) return { integrations: [], allow: {}, errors };
  return { integrations: value.integrations, allow, errors: [] };
}

export function integrationsPath({ repo = repoRoot() } = {}) {
  return join(repo, 'integrations.json');
}

// A missing manifest is "nothing declared", not an error: a machine can be
// managed for its instruction files alone.
export function readIntegrations({ repo = repoRoot() } = {}) {
  const path = integrationsPath({ repo });
  if (!existsSync(path)) return { integrations: [], allow: {}, errors: [] };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { integrations: [], allow: {}, errors: [`integrations.json is not valid JSON: ${err.message}`] };
  }
  return validateIntegrations(parsed, { repo });
}
