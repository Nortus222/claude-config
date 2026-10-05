export type Value = string | boolean;
const base: Record<string, Value> = { model: 'balanced', theme: 'dark', telemetry: true };
const override: Record<string, Value> = { model: 'fast', telemetry: false };
const initial: Record<string, Value> = { ...base };

export function inspectFixture(current: Record<string, Value> = initial) {
  const rows = Object.entries(base).map(([key, value]) => {
    const overridden = Object.hasOwn(override, key);
    const desired = overridden ? override[key]! : value;
    return {
      key,
      base: value,
      override: overridden ? override[key]! : null,
      desired,
      current: current[key]!,
      source: overridden ? 'machine override' : 'base profile',
      changed: current[key] !== desired,
    };
  });
  return {
    profile: 'Sample agent',
    machine: 'Fixture laptop',
    rows,
    diff: rows
      .filter((row) => row.changed)
      .map((row) => ({ key: row.key, before: row.current, after: row.desired })),
  };
}
type Snapshot = ReturnType<typeof inspectFixture>;
export type Fixture = {
  profile: string;
  machine: string;
  rows: ReadonlyArray<Snapshot['rows'][number]>;
  diff: ReadonlyArray<Snapshot['diff'][number]>;
};
export function desiredFixture(): Record<string, Value> {
  return { ...base, ...override };
}
