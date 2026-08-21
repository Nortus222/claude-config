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

function writeDocument(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  // Same serialization claude-hooks.mjs already uses for this file. It
  // normalises the whole document's formatting on first write, which is worth
  // knowing: the keys this tool does not own keep their values, not their
  // whitespace.
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

// Drop baselines for keys the repo file no longer names, so a key removed from
// the manifest leaves no record behind to be reconciled against forever.
function prune(lock, prefix, owned) {
  for (const recorded of staleBaselineKeys(lock.files, prefix, owned)) delete lock.files[recorded];
}

// repo -> machine, per key. Refuses a conflict unless force is set, never
// touches a key whose only change is local, and never touches a key the repo
// file does not name.
export function applyMerge(src, dest, prefix, lock, { force = false, relative = dest, agent = null } = {}) {
  const inspected = inspectMerge(src, dest, prefix, lock);

  if (inspected.state === 'missing-repo') return { action: 'skipped', backedUp: null, keys: [] };
  if (inspected.state === 'unparseable-local') {
    // Nothing is preserved because nothing is being overwritten — the file is
    // exactly as the user left it. `reason` distinguishes this from a
    // conflict refusal: neither --take-repo nor --take-local can fix invalid
    // JSON, so the caller must not offer them as a remedy for this one.
    return { action: 'refused', backedUp: null, keys: [], reason: 'unparseable-local' };
  }

  const conflicts = inspected.keys.filter((k) => k.state === 'conflict');
  if (conflicts.length > 0 && !force) {
    // Preserve the local side even though nothing is being written, so the
    // user can resolve from a stable copy while continuing to work.
    return { action: 'refused', backedUp: preserveCopy(dest, relative, agent), keys: conflicts };
  }

  const writing = inspected.keys.filter(
    (k) => NEEDS_APPLY.has(k.state) || (force && k.state === 'conflict'),
  );

  if (writing.length === 0) {
    // Converged: both sides already agree, so only the baseline is stale.
    // Restamp only the keys where it actually is — mirroring applyCopy's own
    // guard — so a clean second run leaves the lockfile, and its mtime,
    // byte-identical instead of touching every key's appliedAt.
    for (const { key } of inspected.keys) {
      const hash = hashValue(inspected.repo[key]);
      if (lock.files[`${prefix}#${key}`]?.hash !== hash) {
        setBaseline(lock, `${prefix}#${key}`, hash);
      }
    }
    prune(lock, prefix, inspected.owned);
    return { action: 'skipped', backedUp: null, keys: [] };
  }

  // Copy rather than move: the rest of this document has to stay where it is,
  // because what follows rewrites it in place rather than replacing it.
  const backedUp = preserveCopy(dest, relative, agent);

  const next = { ...inspected.local };
  for (const { key } of writing) next[key] = inspected.repo[key];
  writeDocument(dest, next);

  for (const { key } of inspected.keys) {
    setBaseline(lock, `${prefix}#${key}`, hashValue(inspected.repo[key]));
  }
  prune(lock, prefix, inspected.owned);

  return { action: 'copied', backedUp, keys: writing };
}

// machine -> repo. Mirrors applyMerge with the directions swapped, and reads
// only the keys the repo file already names: capture must not turn a local
// extra into policy for every other machine.
export function captureMerge(src, dest, prefix, lock, { force = false, relative = dest, agent = null } = {}) {
  const inspected = inspectMerge(src, dest, prefix, lock);

  if (inspected.state === 'missing-repo') return { action: 'skipped', backedUp: null, keys: [] };
  // Same distinguishing reason as applyMerge — see there for why the caller
  // needs it.
  if (inspected.state === 'unparseable-local') return { action: 'refused', backedUp: null, keys: [], reason: 'unparseable-local' };

  const conflicts = inspected.keys.filter((k) => k.state === 'conflict');
  if (conflicts.length > 0 && !force) {
    return { action: 'refused', backedUp: preserveCopy(dest, relative, agent), keys: conflicts };
  }

  // A key the machine does not have is not a deletion — see the spec: with one
  // baseline hash there is no way to tell "never had it" from "removed it", so
  // an absent local value is left as the repo has it.
  //
  // 'unmanaged' — no baseline recorded yet — is included alongside
  // NEEDS_CAPTURE: captureCopy captures a never-synced file on first contact
  // (it falls through the same way as local-ahead), and captureMerge has to
  // match that or a machine's very first capture of a declared key would
  // silently do nothing.
  const writing = inspected.keys.filter(
    (k) =>
      (NEEDS_CAPTURE.has(k.state) || k.state === 'unmanaged' || (force && k.state === 'conflict')) &&
      inspected.local[k.key] !== undefined,
  );

  if (writing.length === 0) {
    // Same convergence guard as applyMerge: restamp only where the baseline
    // is actually stale, so a clean second run leaves the lockfile untouched.
    for (const { key } of inspected.keys) {
      if (inspected.local[key] !== undefined) {
        const hash = hashValue(inspected.local[key]);
        if (lock.files[`${prefix}#${key}`]?.hash !== hash) {
          setBaseline(lock, `${prefix}#${key}`, hash);
        }
      }
    }
    prune(lock, prefix, inspected.owned);
    return { action: 'skipped', backedUp: null, keys: [] };
  }

  // The repo file is a working-tree file: an uncommitted edit to it is not
  // recoverable from git, so preserve it before it is rewritten.
  const backedUp = preserveCopy(src, `${relative}.repo`, agent);

  const next = { ...inspected.repo };
  for (const { key } of writing) next[key] = inspected.local[key];
  writeDocument(src, next);

  for (const { key } of inspected.keys) {
    if (inspected.local[key] !== undefined) {
      setBaseline(lock, `${prefix}#${key}`, hashValue(next[key]));
    }
  }
  prune(lock, prefix, inspected.owned);

  return { action: 'copied', backedUp, keys: writing };
}
