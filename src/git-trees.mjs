import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The only place `git` is invoked for update checks. Everything upstream of
// this file deals in tree SHAs, so a change to git's flags is contained here.

// --filter=blob:none fetches every tree but no file contents, and --no-checkout
// skips materialising a working copy — a tree SHA is all this needs, and
// downloading the files to compute one would be waste. Out-of-band
// measurement against a real remote (mattpocock/skills, over https): 0.45s
// and 136K, versus a full clone. --filter is inert against the local
// file:// fixtures the test suite uses (git reports "filtering not
// recognized by server, ignoring"), so that figure is not something the
// suite guards — only --depth's shallow-clone effect is asserted locally.
export function buildCloneArgs(sourceUrl, dir) {
  return ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--quiet', sourceUrl, dir];
}

export function buildRevParseArgs(path) {
  return ['rev-parse', `HEAD:${path}`];
}

function runGit(args, { cwd } = {}) {
  return new Promise((resolve) => {
    // Piped, not inherited: the SHA is the return value, and git's progress
    // chatter would otherwise land in the middle of the report.
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    // git missing from PATH entirely: report it the way a failed command reads.
    child.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
  });
}

// Returns null if the source could not be cloned — the caller reports every
// skill from that source as unknown rather than assuming it is current.
// A path present in the map with a null value exists in the lock but no longer
// exists upstream.
export async function resolveTrees(sourceUrl, paths, { run = runGit } = {}) {
  const trees = new Map();
  if (paths.length === 0) return trees;

  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-trees-'));
  try {
    const cloned = await run(buildCloneArgs(sourceUrl, dir));
    if (cloned.code !== 0) return null;

    for (const path of paths) {
      const res = await run(buildRevParseArgs(path), { cwd: dir });
      // A non-zero exit here is git saying the path is not in HEAD, which is a
      // real answer about the skill, not a failure of the check.
      trees.set(path, res.code === 0 && res.out ? res.out : null);
    }
    return trees;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
