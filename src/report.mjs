const WIDTH = 16;

// `width` exists for callers whose labels are arbitrary rather than chosen —
// a skill name, say. padEnd does nothing to a label already past the pad, so
// one long name silently shunts the state and note columns right for its row
// alone. Callers with fixed labels omit it and keep the shared default, so
// every existing report stays byte-identical.
export function formatRow(label, state, note = '', width = WIDTH) {
  return `  ${label.padEnd(width)} ${state.padEnd(12)} ${note}`.trimEnd();
}

// The label width a set of rows needs to stay aligned. Never narrower than the
// shared default, so a section of short labels still lines up with the ones
// around it rather than drifting left.
export function labelWidth(labels) {
  return Math.max(WIDTH, ...labels.map((l) => l.length));
}

export function section(title, lines) {
  if (lines.length === 0) return `${title}\n  (nothing to report)\n`;
  return `${title}\n${lines.join('\n')}\n`;
}
