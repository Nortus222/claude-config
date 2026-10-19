import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake `git` on PATH: `network` commands (fetch, clone) start a helper process, as git-remote-https
// would, record both pids and hang; any other command exits 0. Never touches the network.
export const hangingGit = (network: ReadonlyArray<string> = ['fetch', 'clone']) => {
  const bin = mkdtempSync(join(tmpdir(), 'machine-hanging-git-'));
  const pids = join(bin, 'pids');
  writeFileSync(join(bin, 'git'), [
    '#!/usr/bin/env node',
    "const { spawn } = require('node:child_process');",
    "const { appendFileSync } = require('node:fs');",
    `if (!${JSON.stringify(network)}.some(verb => process.argv.includes(verb))) process.exit(0);`,
    "const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });",
    `appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n' + helper.pid + '\\n');`,
    'setTimeout(() => {}, 60_000);',
  ].join('\n') + '\n');
  chmodSync(join(bin, 'git'), 0o755);
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  };
  return {
    path: `${bin}:${process.env.PATH ?? ''}`,
    // The recorded pids still running after up to two seconds; [] once git and its helper are gone.
    survivors: async () => {
      const recorded = existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number) : [];
      if (recorded.length !== 2) throw new Error(`expected git and its helper to record pids, got ${recorded.length}`);
      const deadline = Date.now() + 2000;
      while (recorded.some(alive) && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
      return recorded.filter(alive);
    },
  };
};
