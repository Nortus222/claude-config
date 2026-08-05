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
  if (isSymlink) {
    try {
      target = resolve(readlinkSync(dest));
    } catch {
      target = null;
    }
  }

  return {
    state: linkState({ exists: true, isSymlink, target, expectedTarget: resolve(expectedTarget) }),
    target,
  };
}

export function ensureLink(dest, target, relative) {
  const { state } = inspectLink(dest, target);
  if (state === 'linked') return { state: 'linked', backedUp: null };

  let backedUp = null;
  if (state === 'wrong-target') {
    // A wrong link holds no content of its own, so remove it rather than
    // filling the backup directory with dangling links.
    rmSync(dest, { recursive: true, force: true });
  } else if (state === 'clobbered') {
    backedUp = backupOnce(dest, relative);
  }

  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(resolve(target), dest, DIR_LINK_TYPE);
  return { state: 'linked', backedUp };
}
