import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, installerCalls, machine, runCli, type Machine } from './support/cli.ts';

// A machine with `pinme` installed from a local upstream repo. `lockRef` is the ref the installer
// recorded: 'pin' the pinned commit, null none, anything else verbatim. `pin` writes the pin itself.
export function pinnedMachine(options: { lockRef: string | null | 'pin'; pin: boolean }): { m: Machine; sha: string; upstream: string } {
  const m = machine();
  const upstream = mkdtempSync(join(tmpdir(), 'nortuscc-offpin-upstream-'));
  git(upstream, 'init', '-q');
  mkdirSync(join(upstream, 's', 'pinme'), { recursive: true });
  writeFileSync(join(upstream, 's', 'pinme', 'SKILL.md'), '# pinme\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-qm', 'pinme');
  const sha = git(upstream, 'rev-parse', 'HEAD');

  writeFileSync(join(m.repo, 'skills-manifest.txt'), '[o/r]\npinme\n');
  if (options.pin) writeFileSync(join(m.repo, 'skill-pins.json'), JSON.stringify({ version: 1, pins: { 'o/r': sha } }));

  const stored = join(m.agents, 'pinme');
  mkdirSync(stored, { recursive: true });
  writeFileSync(join(stored, 'SKILL.md'), '# pinme\n');
  mkdirSync(join(m.claude, 'skills'), { recursive: true });
  symlinkSync(stored, join(m.claude, 'skills', 'pinme'), 'dir');
  mkdirSync(join(m.codex, 'skills', 'pinme'), { recursive: true });

  const ref = options.lockRef === 'pin' ? sha : options.lockRef;
  const entry = {
    source: 'o/r', sourceUrl: `file://${upstream}`, skillPath: 's/pinme/SKILL.md', skillFolderHash: 'x',
    ...(ref === null ? {} : { ref }),
  };
  writeFileSync(join(dirname(m.agents), '.skill-lock.json'), JSON.stringify({ skills: { pinme: entry } }));
  return { m, sha, upstream };
}

test('update --check reports a skill installed off its pin and exits 1', async () => {
  const { m, sha } = pinnedMachine({ lockRef: 'b'.repeat(40), pin: true });
  const result = await runCli(m, ['update', '--check']);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /off-pin\s+1\s+pinme/);
  assert.match(result.stdout, new RegExp(`pinme\\s+off-pin\\s+installed at bbbbbbb, pinned to ${sha.slice(0, 7)}`));
  assert.match(result.stdout, /Run: nortuscc update/);
  assert.deepEqual(installerCalls(m), []);
});

test('update --check with a skill at its pin exits 0', async () => {
  const { m } = pinnedMachine({ lockRef: 'pin', pin: true });
  const result = await runCli(m, ['update', '--check']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /current\s+1/);
  assert.doesNotMatch(result.stdout, /off-pin/);
});

// Replaces this machine's fake npx with one that installs at a pin the way verification expects: on
// `-y skills add <source>#<sha> --skill <names…>` it writes each skill's SKILL.md from the upstream commit
// (NORTUSCC_TEST_UPSTREAM_DIR) into the store and records the sha as the lock's ref. Other verbs exit 0.
function installPinnedFakeNpx(m: Machine): void {
  const path = join(m.bin, 'npx');
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] === '-y' && argv[1] === 'skills' && argv[2] === 'add') {
  appendFileSync(process.env.NORTUSCC_TEST_LOG, JSON.stringify({ cmd: 'npx', args: argv }) + '\\n');
  const sha = argv[3].split('#')[1];
  const listAfter = (flag) => {
    const out = [];
    for (let i = argv.indexOf(flag) + 1; i > 0 && i < argv.length && !argv[i].startsWith('--'); i += 1) out.push(argv[i]);
    return out;
  };
  const store = process.env.NORTUSCC_AGENTS_DIR;
  const lockPath = join(dirname(store), '.skill-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  for (const skill of listAfter('--skill')) {
    const stored = join(store, skill);
    rmSync(stored, { recursive: true, force: true });
    mkdirSync(stored, { recursive: true });
    const body = execFileSync('git', ['-C', process.env.NORTUSCC_TEST_UPSTREAM_DIR, 'show', sha + ':s/' + skill + '/SKILL.md']);
    writeFileSync(join(stored, 'SKILL.md'), body);
    lock.skills[skill] = { ...lock.skills[skill], ref: sha };
    for (const agent of listAfter('--agent')) {
      if (agent === 'claude-code') {
        const placed = join(process.env.NORTUSCC_CLAUDE_DIR, 'skills', skill);
        mkdirSync(dirname(placed), { recursive: true });
        if (!existsSync(placed)) symlinkSync(stored, placed, 'dir');
      } else if (agent === 'codex') {
        mkdirSync(join(process.env.NORTUSCC_CODEX_DIR, 'skills', skill), { recursive: true });
      }
    }
  }
  writeFileSync(lockPath, JSON.stringify(lock));
}
`);
  chmodSync(path, 0o755);
}

test('update --yes reinstalls an off-pin skill at its pin and exits 0', async () => {
  const { m, sha, upstream } = pinnedMachine({ lockRef: 'b'.repeat(40), pin: true });
  installPinnedFakeNpx(m);
  const result = await runCli(m, ['update', '--yes'], { env: { NORTUSCC_TEST_UPSTREAM_DIR: upstream } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const add = installerCalls(m).find((c) => c.args[2] === 'add')!;
  assert.equal(add.args[3], `o/r#${sha}`);
  assert.match(result.stdout, /pinme\s+reinstalled\s+o\/r#/);
  assert.doesNotMatch(result.stdout, /pinme\s+added/);
});
