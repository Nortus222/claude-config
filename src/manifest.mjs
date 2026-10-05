import FILES from '../packages/profile-engine/src/files.json' with { type: 'json' };

// What syncs and how, in the shape the legacy commands read. The table itself is the engine's packages/profile-engine/src/files.json; this only renames its fields.
//
// Every entry carries the agent it belongs to, so one manifest serves both
// targets and `--target` is a filter over this table rather than a second
// implementation of every command.
//
// mode: 'copy' — an agent rewrites its instruction file in place, which would
//                silently replace a symlink with a regular file. Copy it and
//                track a hash.
//                preserveProjects keeps Codex project tables machine-local,
//                excluding them from hashes and retaining them during apply.
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
export const SYNC = FILES.map((file) => ({
  target: file.target,
  ...(file.home !== file.target ? { machine: file.home } : {}),
  src: file.src,
  dest: file.dest,
  mode: file.mode,
  ...(file.preserveProjects ? { preserveProjects: true } : {}),
  ...(file.capture ? {} : { capture: false }),
}));
