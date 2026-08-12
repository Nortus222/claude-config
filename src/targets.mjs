// The agents nortuscc can configure. Every path decision, manifest filter and
// skill install narrows through this list, so adding an agent here is the one
// edit that widens all of them at once.
export const TARGETS = ['claude', 'codex'];

const ALLOWED = [...TARGETS, 'all'];

// Parsed before each command's own flag parsing, so `--target` and its value
// never reach a parser that would report them as unknown options. `rest` is
// what the command then sees: the original args with exactly those two
// removed.
export function parseTarget(args) {
  const rest = [];
  let target = 'all';
  let seen = false;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--target') {
      rest.push(args[i]);
      continue;
    }

    // Refuse the second occurrence even when it repeats the first value.
    // "Only one distinct value" would be a rule the next reader has to infer;
    // "only once" is one they can read off the message.
    if (seen) return { target: 'all', rest, error: '--target may be supplied only once' };
    seen = true;

    const value = args[i + 1];
    // A flag-shaped value is a missing argument, not an agent named
    // `--skills`. Swallowing it would drop it from `rest` as well, silently
    // disabling the very flag the user typed — the same reason update's
    // `--add` refuses to read a following flag as a skill name.
    if (!value || value.startsWith('-')) {
      return { target: 'all', rest, error: '--target requires claude, codex, or all' };
    }
    if (!ALLOWED.includes(value)) {
      return { target: 'all', rest, error: '--target must be claude|codex|all' };
    }

    target = value;
    i += 1;
  }

  return { target, rest, error: null };
}

// A fresh array every call: TARGETS itself is shared by every caller, and one
// caller's sort() or push() must not rewrite the next one's answer.
export function selectedTargets(target) {
  return target === 'all' ? [...TARGETS] : [target];
}

export function entriesForTarget(entries, target) {
  return entries.filter((entry) => target === 'all' || entry.target === target);
}
