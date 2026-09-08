// The single source of truth for what syncs and how.
//
// Every entry carries the agent it belongs to, so one manifest serves both
// targets and `--target` is a filter over this table rather than a second
// implementation of every command.
//
// mode: 'copy' — an agent rewrites its instruction file in place, which would
//                silently replace a symlink with a regular file. Copy it and
//                track a hash.
//
// mode: 'merge-keys' — a settings file mixes portable rules with permissions,
//                UI preferences and machine-specific state. Sync the keys the
//                repo names and leave every other key exactly as found. The
//                key set in the repo's file IS the allowlist: nothing here
//                enumerates the machine's own keys, so a local secret can
//                never be picked up.
//
// `hooks` is deliberately not owned. src/integrations/claude-hooks.mjs already
// writes settings.hooks, and a second writer would let `apply` undo what
// `apply --install` registered; `status` already reports undeclared hooks.
export const SYNC = [
  { target: 'claude', src: 'claude/CLAUDE.md', dest: 'CLAUDE.md', mode: 'copy' },
  { target: 'codex', src: 'codex/AGENTS.md', dest: 'AGENTS.md', mode: 'copy' },
  {
    target: 'codex',
    machine: 'codex-openrouter',
    src: 'codex/openrouter-glm/models-static.json',
    dest: 'models-static.json',
    mode: 'copy',
    capture: false,
  },
  {
    target: 'codex',
    machine: 'codex-openrouter',
    src: 'codex/openrouter-glm/config.toml',
    dest: 'config.toml',
    mode: 'copy',
    capture: false,
  },
  { target: 'claude', src: 'claude/settings.keys.json', dest: 'settings.json', mode: 'merge-keys' },
];
