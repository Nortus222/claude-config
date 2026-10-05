import { Schema } from 'effect';
import { TARGETS } from './model.ts';
import type { Input, MachineOverrides, Target } from './model.ts';
import { decode, isPlainObject } from './issues.ts';

const OverridesDocument = Schema.Struct({
  version: Schema.Literal(1),
  manageConfig: Schema.optional(Schema.Boolean),
  configTargets: Schema.optional(Schema.Array(Schema.Literals([...TARGETS]))),
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
  skills: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  integrations: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});

// One machine's choices. Where they are stored is the caller's concern; a malformed document
// overrides nothing and reports why.
export function decodeOverrides(value: unknown, source: string): Input<MachineOverrides> {
  const decoded = decode(OverridesDocument, value, 'machine', source);
  if (!decoded.ok) return { value: {}, source, issues: [decoded.issue] };
  const { version: _version, ...overrides } = decoded.value;
  return { value: overrides, source, issues: [] };
}

export const LEGACY_STATE_SOURCE = 'state.json';

// The two machine choices the CLI already records in state.json, read with parseState's rules
// (src/lock.mjs): only a literal `skillsOnly: true` stops configuration being managed, and
// `configTargets` counts only as a list of known targets. A missing, corrupt or misshapen
// record decides nothing, exactly as the CLI treats it as a first run.
export function overridesFromLegacyState(text: string | undefined, source = LEGACY_STATE_SOURCE): Input<MachineOverrides> {
  const none: Input<MachineOverrides> = { value: {}, source, issues: [] };
  if (text === undefined) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return none;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.files)) return none;

  const targets = parsed.configTargets;
  const knownTargets =
    Array.isArray(targets) && targets.every((t) => (TARGETS as ReadonlyArray<unknown>).includes(t))
      ? [...new Set(targets as Target[])]
      : undefined;

  return {
    value: {
      ...(parsed.skillsOnly === true ? { manageConfig: false } : {}),
      ...(knownTargets ? { configTargets: knownTargets } : {}),
    },
    source,
    issues: [],
  };
}
