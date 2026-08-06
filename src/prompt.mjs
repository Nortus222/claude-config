import { createInterface } from 'node:readline/promises';

// Only an explicit yes is a yes. Everything else — including a bare Enter —
// is no, so the safe answer is the one that takes no effort to give.
export function interpret(answer) {
  return /^y(es)?$/i.test(String(answer).trim());
}

// null, not false, when there is no TTY: the caller has to tell "the user
// declined" apart from "there was nobody to ask". A scheduled run that blocks
// forever on a prompt nothing will answer is worse than one that fails.
export async function confirm(question, {
  input = process.stdin,
  output = process.stdout,
  isTTY = process.stdin.isTTY,
} = {}) {
  if (!isTTY) return null;
  const rl = createInterface({ input, output });
  try {
    return interpret(await rl.question(`${question} [y/N] `));
  } finally {
    rl.close();
  }
}
