// Pure derivation for key-level sync: no node:fs, no reads, no writes.
// src/merge-keys.mjs does every I/O operation and hands parsed documents here,
// the same split src/state.mjs and src/copy.mjs already draw.
import { fileState } from './state.mjs';
import { hashText } from './lock.mjs';

// A JSON document can be rewritten with its keys in a different order and mean
// exactly the same thing — agents rewrite these files in place, so that
// happens. Digesting the raw text would report it as drift on every machine.
// Arrays are left in order: they are ordered data, and reordering one IS a
// change.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// null rather than a digest of "undefined": fileState already reads null as
// "not present on this side", so an absent key needs no special case there.
export function hashValue(value) {
  return value === undefined ? null : hashText(canonical(value));
}

// `claude:settings.json#effortLevel`. The `#` separates the document from the
// key inside it, so a per-key baseline can never collide with the whole-file
// baseline of a copied entry.
export function baselineKey(target, dest, key) {
  return `${target}:${dest}#${key}`;
}

// One three-way state per owned key, from the same pure state machine that
// classifies whole files. `local` is null when the document itself is absent,
// which makes every key read as the repo being ahead — recoverable, not lost.
export function keyStates({ owned, repo = {}, local = null, baselines = {} }) {
  return owned.map((key) => ({
    key,
    state: fileState({
      baseline: baselines[key],
      repo: hashValue(repo[key]),
      local: local === null ? null : hashValue(local[key]),
    }),
  }));
}

// Baselines under this document's prefix whose key is no longer owned. A key
// dropped from the repo file stops being managed, and leaving its baseline
// behind would accumulate records nothing will ever reconcile again.
//
// The `#` is required, so the whole-file baseline of a copied entry sharing
// this prefix is never mistaken for a stale key.
export function staleBaselineKeys(files, prefix, owned) {
  const keep = new Set(owned);
  return Object.keys(files)
    .filter((recorded) => recorded.startsWith(`${prefix}#`))
    .filter((recorded) => !keep.has(recorded.slice(prefix.length + 1)));
}
