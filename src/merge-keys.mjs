// Key-level sync: repo <-> machine for named keys of a JSON document, leaving
// every key the repo does not name exactly as it was found.
//
// Mirrors src/copy.mjs — same action vocabulary, same force semantics, same
// backup-before-write rule — so apply, capture and status dispatch on `mode`
// and need to know nothing else. src/settings-keys.mjs holds the derivation;
// this file does the I/O.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { NEEDS_APPLY, NEEDS_CAPTURE } from './state.mjs';
import { setBaseline } from './lock.mjs';
import { preserveCopy } from './backup.mjs';
import { hashValue, keyStates, staleBaselineKeys, validateOwnedKeys } from './settings-keys.mjs';

// Absent and unreadable are different answers. A machine that has never run
// the agent has no settings file, which is ordinary; a file that will not parse
// is the user's, mid-edit or hand-broken, and never ours to replace.
export function readDocument(path) {
  if (!existsSync(path)) return { value: null, existed: false, corrupt: false };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, existed: true, corrupt: true };
    }
    return { value: parsed, existed: true, corrupt: false };
  } catch {
    return { value: null, existed: true, corrupt: true };
  }
}

// Most severe first: one conflicting key must not hide behind clean ones.
// Each state is named explicitly rather than tested against the BLOCKED set,
// which would collapse `missing-repo` into `conflict` and mislabel it.
function rollUp(keys) {
  if (keys.some((k) => k.state === 'conflict')) return 'conflict';
  if (keys.some((k) => k.state === 'missing-repo')) return 'missing-repo';
  if (keys.some((k) => NEEDS_CAPTURE.has(k.state))) return 'local-ahead';
  if (keys.some((k) => NEEDS_APPLY.has(k.state))) return 'repo-ahead';
  return 'clean';
}

function baselinesUnder(lock, prefix, owned) {
  const found = {};
  for (const key of owned) found[key] = lock.files[`${prefix}#${key}`]?.hash;
  return found;
}

// `prefix` is the state-file prefix for this document — `claude:settings.json`.
export function inspectMerge(src, dest, prefix, lock) {
  const repo = readDocument(src);
  // A repo file that is absent, unreadable or refused decides nothing. Every
  // command already knows to leave missing-repo alone.
  if (!repo.existed || repo.corrupt) {
    return { state: 'missing-repo', keys: [], owned: [], repo: null, local: null, errors: [] };
  }
  const errors = validateOwnedKeys(repo.value);
  if (errors.length) {
    return { state: 'missing-repo', keys: [], owned: [], repo: null, local: null, errors };
  }

  const owned = Object.keys(repo.value);
  const local = readDocument(dest);
  if (local.corrupt) {
    return { state: 'unparseable-local', keys: [], owned, repo: repo.value, local: null, errors: [] };
  }

  const keys = keyStates({
    owned,
    repo: repo.value,
    local: local.existed ? local.value : null,
    baselines: baselinesUnder(lock, prefix, owned),
  });

  return { state: rollUp(keys), keys, owned, repo: repo.value, local: local.existed ? local.value : {}, errors: [] };
}
