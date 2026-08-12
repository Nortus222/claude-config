// JSON from a source this tool does not own can hand back null, arrays or
// scalars anywhere an object is expected, and `typeof x === 'object'` alone
// rules out none of those. Shared by every reader of a third-party file:
// `.skill-lock.json`, the agents' plugin state, and the integration manifest.
//
// This lived in plugins.mjs, which the integration adapters replaced; the
// check outlived that module because it was never about plugins.
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
