// Line diff for draft previews: unified-style hunks with surrounding context lines.

export type DiffLine = { readonly kind: 'context' | 'add' | 'remove'; readonly text: string };
// Starts are 1-based line numbers; a side with no lines starts at the line before the change, as in unified diffs.
export type Hunk = { readonly beforeStart: number; readonly beforeCount: number; readonly afterStart: number; readonly afterCount: number; readonly lines: readonly DiffLine[] };

// Above this many comparison cells the changed middle is shown as a whole replacement instead of an LCS.
const MAX_CELLS = 1_000_000;

const split = (text: string | null): string[] => {
  if (!text) return [];
  const rows = text.split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows;
};

// Edit script between two line lists: common prefix and suffix, LCS over the middle.
function script(a: readonly string[], b: readonly string[]): DiffLine[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head = a.slice(0, start).map(text => ({ kind: 'context' as const, text }));
  const tail = a.slice(endA).map(text => ({ kind: 'context' as const, text }));
  const n = endA - start, m = endB - start;
  const middle: DiffLine[] = [];
  if (n * m > MAX_CELLS) {
    for (let i = start; i < endA; i++) middle.push({ kind: 'remove', text: a[i]! });
    for (let j = start; j < endB; j++) middle.push({ kind: 'add', text: b[j]! });
    return [...head, ...middle, ...tail];
  }
  // lcs[i * (m + 1) + j] = LCS length of a[start + i..endA) and b[start + j..endB).
  const width = m + 1, lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    lcs[i * width + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { middle.push({ kind: 'context', text: a[start + i]! }); i++; j++; }
    else if (i < n && (j === m || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) { middle.push({ kind: 'remove', text: a[start + i]! }); i++; }
    else { middle.push({ kind: 'add', text: b[start + j]! }); j++; }
  }
  return [...head, ...middle, ...tail];
}

// Hunks turning `before` into `after`; null means the file is absent on that side. Identical text has none.
export function lineDiff(before: string | null, after: string | null, context = 3): Hunk[] {
  const lines = script(split(before), split(after));
  const changed = lines.flatMap((line, index) => line.kind === 'context' ? [] : [index]);
  const hunks: Hunk[] = [];
  // Line numbers before each row of the script, on both sides.
  const beforeAt: number[] = [], afterAt: number[] = [];
  let a = 0, b = 0;
  for (const line of lines) { beforeAt.push(a); afterAt.push(b); if (line.kind !== 'add') a++; if (line.kind !== 'remove') b++; }
  // Changes separated by at most twice the context share one hunk.
  for (let k = 0; k < changed.length; k++) {
    const first = changed[k]!;
    let last = first;
    while (k + 1 < changed.length && changed[k + 1]! - last <= 2 * context + 1) last = changed[++k]!;
    hunks.push(hunk(lines, beforeAt, afterAt, Math.max(0, first - context), Math.min(lines.length, last + context + 1)));
  }
  return hunks;
}

function hunk(lines: readonly DiffLine[], beforeAt: readonly number[], afterAt: readonly number[], from: number, to: number): Hunk {
  const slice = lines.slice(from, to);
  const beforeCount = slice.filter(line => line.kind !== 'add').length;
  const afterCount = slice.filter(line => line.kind !== 'remove').length;
  return { beforeStart: beforeAt[from]! + (beforeCount ? 1 : 0), beforeCount, afterStart: afterAt[from]! + (afterCount ? 1 : 0), afterCount, lines: slice };
}
