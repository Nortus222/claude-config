import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { SYNC } from '../manifest.mjs';
import { backupOnce, preserveCopy } from '../backup.mjs';
import { inspectCopy } from '../copy.mjs';
import { readLock, writeLock } from '../lock.mjs';
import { readDocument } from '../merge-keys.mjs';
import { splitProjectTrust } from '../project-trust.mjs';
import { backupRoot, resolveEntry } from '../resolve.mjs';
import { formatRow, section } from '../report.mjs';
import { hashValue } from '../settings-keys.mjs';
import { parseTarget } from '../targets.mjs';

function recordedKeys(lock, entry) {
  const prefix = `${entry.target}:${entry.dest}`;
  return Object.keys(lock.files).filter((key) => key === prefix || key.startsWith(`${prefix}#`));
}

function originalBackup(entry) {
  const root = backupRoot();
  if (!existsSync(root)) return null;

  const runs = readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory() && item.name.startsWith('nortuscc-'))
    .map((item) => item.name)
    .sort();

  for (const run of runs) {
    const candidate = join(root, run, entry.target, entry.dest);
    try {
      lstatSync(candidate);
      return candidate;
    } catch {
      // No backup for this entry in this run.
    }
  }
  return null;
}

function uninstallBackup(entry) {
  return join('uninstall', entry.dest);
}

function restoreOriginal(origin, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  if (lstatSync(origin).isSymbolicLink()) {
    symlinkSync(readlinkSync(origin), dest, 'file');
  } else {
    copyFileSync(origin, dest);
  }
}

function restoreCopy(entry, dest, origin) {
  if (entry.preserveProjects) {
    if (!existsSync(dest)) {
      if (origin) restoreOriginal(origin, dest);
      return { action: origin ? 'restored' : 'removed', backedUp: null };
    }

    const projects = splitProjectTrust(readFileSync(dest, 'utf8')).projects;
    const managed = origin
      ? splitProjectTrust(readFileSync(origin, 'utf8')).managed
      : '';
    const next = managed && projects ? `${managed}\n${projects}` : managed || projects;

    if (!next) {
      const backedUp = existsSync(dest) ? backupOnce(dest, uninstallBackup(entry), entry.target) : null;
      return { action: 'removed', backedUp };
    }

    const backedUp = existsSync(dest) ? preserveCopy(dest, uninstallBackup(entry), entry.target) : null;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, next, 'utf8');
    return { action: origin ? 'restored' : 'preserved', backedUp };
  }

  const backedUp = existsSync(dest) ? backupOnce(dest, uninstallBackup(entry), entry.target) : null;
  if (origin) restoreOriginal(origin, dest);
  return { action: origin ? 'restored' : 'removed', backedUp };
}

function restoreMerged(entry, dest, origin, keys) {
  const currentDocument = readDocument(dest);
  if (currentDocument.corrupt) {
    const backedUp = backupOnce(dest, uninstallBackup(entry), entry.target);
    if (origin) restoreOriginal(origin, dest);
    return { action: origin ? 'restored' : 'removed', backedUp };
  }

  if (!currentDocument.existed) {
    if (origin) restoreOriginal(origin, dest);
    return { action: origin ? 'restored' : 'removed', backedUp: null };
  }

  const originalDocument = origin ? readDocument(origin) : { value: {}, corrupt: false };
  if (originalDocument.corrupt) throw new Error(`nortuscc: backup could not be parsed: ${origin}`);

  const current = currentDocument.existed ? currentDocument.value : {};
  const original = origin ? originalDocument.value : {};
  const next = { ...current };

  for (const recorded of keys) {
    const key = recorded.slice(recorded.indexOf('#') + 1);
    if (Object.hasOwn(original, key)) next[key] = original[key];
    else delete next[key];
  }

  if (Object.keys(next).length === 0 && !origin) {
    const backedUp = existsSync(dest) ? backupOnce(dest, uninstallBackup(entry), entry.target) : null;
    return { action: 'removed', backedUp };
  }

  const backedUp = existsSync(dest) ? preserveCopy(dest, uninstallBackup(entry), entry.target) : null;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { action: 'restored', backedUp };
}

function changedSinceApply(entry, keys, lock) {
  const { src, dest } = resolveEntry(entry);
  if (entry.mode !== 'merge-keys') {
    const baseline = lock.files[keys[0]]?.hash;
    return inspectCopy(src, dest, baseline, entry).local !== baseline;
  }

  const current = readDocument(dest);
  if (current.corrupt) return true;
  const value = current.existed ? current.value : {};
  return keys.some((recorded) => {
    const key = recorded.slice(recorded.indexOf('#') + 1);
    return hashValue(value[key]) !== lock.files[recorded]?.hash;
  });
}

export async function run(args = []) {
  const { target, rest, error } = parseTarget(args);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }
  if (target !== 'all') {
    console.error('nortuscc: uninstall applies to the whole machine; --target must be all');
    return 2;
  }

  const unknown = rest.filter((arg) => arg !== '--yes' && arg !== '--force');
  if (unknown.length > 0) {
    console.error(`nortuscc: unknown uninstall option '${unknown[0]}'`);
    return 2;
  }

  const yes = rest.includes('--yes');
  const force = rest.includes('--force');
  if (!yes) {
    console.error('nortuscc: uninstall changes files. Re-run with --yes to confirm.');
    return 2;
  }

  const lock = readLock();
  const lines = [];

  // Resolve every original before this run creates its own backups, or a
  // fresh path removed early in the loop could look like a pre-existing file
  // to a later entry.
  const planned = SYNC.map((entry) => ({
    entry,
    keys: recordedKeys(lock, entry),
    origin: originalBackup(entry),
  })).filter((item) => item.keys.length > 0);

  const changed = planned.filter(({ entry, keys }) => changedSinceApply(entry, keys, lock));
  if (changed.length > 0 && !force) {
    process.stdout.write(
      '\n' +
        section(
          'uninstall',
          changed.map(({ entry }) => formatRow(entry.dest, 'changed', 'left untouched')),
        ) +
        `\n${changed.length} managed file(s) changed; nothing was uninstalled. Re-run with --force to preserve and replace them.\n`,
    );
    return 1;
  }

  for (const { entry, keys, origin } of planned) {
    const { dest } = resolveEntry(entry);
    const result = entry.mode === 'merge-keys'
      ? restoreMerged(entry, dest, origin, keys)
      : restoreCopy(entry, dest, origin);
    for (const key of keys) delete lock.files[key];
    lines.push(formatRow(
      entry.dest,
      result.action,
      result.backedUp ? `backed up -> ${result.backedUp}` : '',
    ));
  }

  lock.skillsOnly = true;
  writeLock(lock);
  process.stdout.write('\n' + section('uninstall', lines));
  return 0;
}
