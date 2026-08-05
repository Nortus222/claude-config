const WIDTH = 16;

export function formatRow(label, state, note = '') {
  return `  ${label.padEnd(WIDTH)} ${state.padEnd(12)} ${note}`.trimEnd();
}

export function section(title, lines) {
  if (lines.length === 0) return `${title}\n  (nothing to report)\n`;
  return `${title}\n${lines.join('\n')}\n`;
}
