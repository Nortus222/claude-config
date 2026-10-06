import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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
