import { isSkillAdditionName, normalizeSkillSource } from './author-values.ts';
export { isSkillAdditionName, normalizeSkillSource } from './author-values.ts';
import { Schema } from 'effect';
import { TARGETS } from './model.ts';
import type { Input, MachineOverrides, Target } from './model.ts';
import { decode, isPlainObject, issue } from './issues.ts';
import { isCommitSha } from './pins.ts';

const fields = {
  manageConfig: Schema.optional(Schema.Boolean),
  configTargets: Schema.optional(Schema.Array(Schema.Literals([...TARGETS]))),
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
  skills: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  integrations: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
};
const OverridesDocument = Schema.Struct({ version: Schema.Literal(1), ...fields });

const Addition = Schema.Struct({
  source: Schema.String.check(Schema.makeFilter(value => normalizeSkillSource(value) !== undefined)),
  name: Schema.String.check(Schema.makeFilter(isSkillAdditionName)),
  targets: Schema.Array(Schema.Literals([...TARGETS])).check(Schema.makeFilter(value => value.length > 0)),
  revision: Schema.optional(Schema.String.check(Schema.makeFilter(isCommitSha))),
});
const OverridesV2 = Schema.Struct({ version: Schema.Literal(2), ...fields,
  skillAdditions: Schema.optional(Schema.Array(Addition)),
});
const knownKeys = new Set(['version', ...Object.keys(fields), 'skillAdditions']);

// One machine's choices. Where they are stored is the caller's concern; a malformed document
// overrides nothing and reports why.
export function decodeOverrides(value: unknown, source: string): Input<MachineOverrides> {
  const v2 = isPlainObject(value) && value.version === 2;
  const projection = v2 ? Object.fromEntries(Object.entries(value).filter(([key]) => knownKeys.has(key))) : value;
  const decoded = v2 ? decode(OverridesV2, projection, 'machine', source) : decode(OverridesDocument, projection, 'machine', source);
  if (!decoded.ok) return { value: {}, source, issues: [decoded.issue] };
  const { version: _version, ...overrides } = decoded.value;
  const known: MachineOverrides = overrides;
  return { value: { ...known, ...(known.skillAdditions === undefined ? {} : {
    skillAdditions: known.skillAdditions.map(addition => ({ ...addition, source: normalizeSkillSource(addition.source)!,
      targets: TARGETS.filter(target => addition.targets.includes(target)) })),
  }) }, source, issues: [] };
}

// The current raw document carries forward fields this version does not understand. Validated
// known fields always come from the proposed projection, including intentional removals.
export function serializeOverrides(overrides: MachineOverrides, current: unknown | undefined, source: string):
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly issues: Input<MachineOverrides>['issues'] } {
  if (current !== undefined) {
    const before = decodeOverrides(current, source);
    if (before.issues.length) return { ok: false, issues: before.issues };
  }
  if (!isPlainObject(overrides) || Object.keys(overrides).some(key => key === 'version' || !knownKeys.has(key))) {
    return { ok: false, issues: [issue('machine', source, '', 'invalid proposed overrides fields')] };
  }
  const version = (isPlainObject(current) && current.version === 2) || overrides.skillAdditions !== undefined ? 2 : 1;
  const proposed = decodeOverrides({ ...overrides, version }, source);
  if (proposed.issues.length) return { ok: false, issues: proposed.issues };
  const unknown = version === 2 && isPlainObject(current)
    ? Object.fromEntries(Object.entries(current).filter(([key]) => !knownKeys.has(key))) : {};
  return { ok: true, text: JSON.stringify({ ...unknown, version, ...proposed.value }, null, 2) + '\n' };
}

export const LEGACY_STATE_SOURCE = 'state.json';

// The two machine choices older CLIs recorded in state.json, before overrides.json held them:
// only a literal `skillsOnly: true` stops configuration being managed, and `configTargets`
// counts only as a list of known targets. A missing, corrupt or misshapen record (no `files`
// object) decides nothing, as on a first run.
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
