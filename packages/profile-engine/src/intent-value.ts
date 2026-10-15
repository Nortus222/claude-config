// Bound work before recursive setting/secret validation. Root scalars have depth zero.
export function intentValueProblem(value: unknown): 'bytes' | 'depth' | 'nodes' | 'invalid-json' | undefined {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > 4096 || pending.length > 4096) return 'nodes';
    if (entry.depth > 16) return 'depth';
    const v = entry.value;
    if (v === null || typeof v === 'boolean' || typeof v === 'string') continue;
    if (typeof v === 'number') { if (!Number.isFinite(v)) return 'invalid-json'; continue; }
    if (typeof v !== 'object' || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) return 'invalid-json';
    const values = Array.isArray(v) ? v : Object.values(v);
    if (values.length > 4096) return 'nodes';
    for (const child of values) pending.push({ value: child, depth: entry.depth + 1 });
  }
  // The bounded traversal also rejects cycles by exhausting its depth/node allowance.
  return new TextEncoder().encode(JSON.stringify(value)).length > 32768 ? 'bytes' : undefined;
}
