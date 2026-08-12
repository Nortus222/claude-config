// Pure planning for the shared installation workflow: what the user is
// offered, what starts ticked, and what the review prints. No I/O, so the
// whole decision surface is testable without a terminal or a child process.

// The categories `--no-*` can decline. Configuration is deliberately not one
// of them: it is the thing this tool exists to sync, and declining it is what
// `--target` is for.
export const CATEGORIES = ['hooks', 'mcp', 'plugins', 'skills'];

const GROUP = {
  config: 'configuration',
  skills: 'shared skills',
};

// Flags this workflow does not own are handed back in `rest` rather than
// rejected: the same argv carries apply's own flags, and swallowing them would
// make `apply --install --take-repo` silently drop the conflict resolution.
export function parseInstallFlags(args) {
  const out = { yes: false, disabled: new Set(), error: null, rest: [] };

  for (const arg of args) {
    if (arg === '--yes') { out.yes = true; continue; }

    if (arg.startsWith('--no-')) {
      const category = arg.slice('--no-'.length);
      if (!CATEGORIES.includes(category)) {
        out.error = `unknown option ${arg} (expected one of ${CATEGORIES.map((c) => `--no-${c}`).join(', ')})`;
        return out;
      }
      out.disabled.add(category);
      continue;
    }

    out.rest.push(arg);
  }

  return out;
}

// An item is offered whatever its state, so "already satisfied" stays
// distinguishable from "not offered at all". Only a missing, default-enabled
// item starts ticked: a satisfied one has nothing to do, and a blocked one
// cannot be made to work by ticking it.
function toChoice(item, group) {
  const satisfied = item.state === 'installed';
  const blocked = item.state === 'blocked';

  const note = satisfied
    ? `already installed${item.note ? ` — ${item.note}` : ''}`
    : blocked
      ? `blocked — ${item.note ?? 'a prerequisite is missing'}`
      : item.note ?? '';

  return {
    key: item.id,
    group: item.group ?? group,
    label: item.label,
    note,
    checked: Boolean(item.default) && !satisfied && !blocked,
  };
}

export function buildInstallChoices({ config = [], integrations = [], skills = [] }) {
  return [
    ...config.map((item) => toChoice(item, GROUP.config)),
    ...integrations.map((item) => toChoice(item, item.group ?? 'integrations')),
    ...skills.map((item) => toChoice(item, GROUP.skills)),
  ];
}

// The last thing between a user and a set of child processes. It prints the
// description each item supplied and never reconstructs a command itself, so
// whatever an adapter chose to redact stays redacted.
export function reviewLines(items) {
  if (items.length === 0) return ['  nothing to do'];

  const lines = [];
  let group = null;
  for (const item of items) {
    if (item.group !== group) {
      group = item.group;
      if (lines.length) lines.push('');
      lines.push(`  ${group}`);
    }
    lines.push(`    ${item.label}${item.describe ? `  ${item.describe}` : ''}`);
  }
  return lines;
}
