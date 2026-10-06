// One setup item's value in one DesiredConfig, as the classifier needs it.
export type Entry =
  | {
    readonly kind: 'file'; readonly fileId: string; readonly mode: 'copy' | 'merge-keys'; readonly dest: string;
    readonly managed: boolean; readonly hash: string | undefined;
  }
  | { readonly kind: 'setting'; readonly fileId: string; readonly key: string; readonly managed: boolean; readonly value: unknown }
  | { readonly kind: 'skill'; readonly value: unknown }
  | { readonly kind: 'integration'; readonly value: unknown };

// An item's entry in the applied revision's configuration and in the effective one.
export type Change = { readonly itemId: string; readonly before?: Entry; readonly after?: Entry };

export type HeldReason =
  | 'instruction file removed or no longer managed'
  | 'copied file can declare commands'
  | 'settings key not known to be inert'
  | 'settings key removed'
  | 'skill'
  | 'integration'
  | 'not a known item';

export type Verdict = { readonly kind: 'inert' } | { readonly kind: 'held'; readonly reason: HeldReason };

// Settings keys proven unable to run or steer code, per merge-keys file id. Classification is by
// top-level key, so a nested object is inert only when its whole key is listed. Keys that run or
// steer code (hooks, statusLine, apiKeyHelper, env, permissions, enabledPlugins, …) never belong
// here, and `worktree` waits for a review. Adding a key is a reviewed change with a test row.
export const INERT_KEYS: Readonly<Record<string, ReadonlyArray<string>>> = {
  'claude:settings.json': ['attribution', 'effortLevel', 'model', 'outputStyle', 'theme', 'tui'],
};

const INERT: Verdict = { kind: 'inert' };
const held = (reason: HeldReason): Verdict => ({ kind: 'held', reason });

// The code-running safety rule: a pure function of the item's two entries, never of service data.
// Anything it does not recognise is held for a person on this machine.
export const classify = ({ before, after }: Change): Verdict => {
  const entry = after ?? before;
  if (entry === undefined || (before !== undefined && after !== undefined && before.kind !== after.kind)) {
    return held('not a known item');
  }
  switch (entry.kind) {
    case 'file':
      if (entry.mode !== 'copy' || !entry.dest.endsWith('.md')) return held('copied file can declare commands');
      return after?.kind === 'file' && after.managed && after.hash !== undefined
        ? INERT
        : held('instruction file removed or no longer managed');
    case 'setting':
      if (after?.kind !== 'setting' || !after.managed) return held('settings key removed');
      return Object.hasOwn(INERT_KEYS, after.fileId) && INERT_KEYS[after.fileId]!.includes(after.key)
        ? INERT
        : held('settings key not known to be inert');
    case 'skill':
      // ADR 0014 made pins verified commit SHAs; skills are still held because a skill can bundle
      // scripts that an agent later runs (ADR 0012).
      return held('skill');
    case 'integration':
      return held('integration');
    default:
      return held('not a known item');
  }
};
