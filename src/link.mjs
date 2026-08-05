import { lstatSync, readlinkSync, symlinkSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { linkState } from './state.mjs';
import { backupOnce } from './backup.mjs';

// Junctions need no elevation on Windows, where a plain directory symlink
// requires Developer Mode or admin. On other platforms 'dir' is correct.
const DIR_LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

export function inspectLink(dest, expectedTarget) {
  let stat = null;
  try {
    stat = lstatSync(dest);
  } catch {
    return { state: linkState({ exists: false }), target: null };
  }

  const isSymlink = stat.isSymbolicLink();
  let target = null;
  // Only a symlink can dangle; anything else lstat found is its own content.
  let targetResolves = true;
  if (isSymlink) {
    try {
      // readlinkSync returns the link's raw text, which is relative to the
      // link's own directory when the link itself is relative — not to
      // process.cwd(). An absolute link text is unaffected, since resolve's
      // later argument wins once it is itself absolute.
      target = resolve(dirname(dest), readlinkSync(dest));
    } catch {
      target = null;
    }
    // existsSync follows the link and swallows ENOENT, so false here means the
    // link's target is gone — the same lstat-then-existsSync pair
    // brokenSkillLinks() uses in skills.mjs, kept deliberately identical.
    targetResolves = existsSync(dest);
  }

  return {
    state: linkState({
      exists: true,
      isSymlink,
      target,
      expectedTarget: resolve(expectedTarget),
      targetResolves,
    }),
    target,
  };
}

export function ensureLink(dest, target, relative) {
  const { state } = inspectLink(dest, target);
  if (state === 'linked') return { state: 'linked', backedUp: null };

  let backedUp = null;
  if (state === 'wrong-target' || state === 'broken-link') {
    // Neither a mispointed link nor a dangling one holds content of its own —
    // the link text is the whole of it — so remove it rather than filling the
    // backup directory with links that point nowhere. backupOnce would decline
    // a dangling link anyway: its existsSync guard follows the link.
    rmSync(dest, { recursive: true, force: true });
  } else if (state === 'clobbered') {
    backedUp = backupOnce(dest, relative);
  }

  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(resolve(target), dest, DIR_LINK_TYPE);

  // Report what is actually there now, not what was attempted. Rebuilding a
  // link cannot conjure up a target that the repo no longer has, and claiming
  // 'linked' in that case would restate the very lie this state machine was
  // extended to catch.
  return { state: inspectLink(dest, target).state, backedUp };
}
