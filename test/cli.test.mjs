import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `--help` is answered by bin/nortuscc.mjs before it imports any command, so
// running it for real touches no config, no repo and no network — it only
// prints the usage text and exits 0.
const BIN = fileURLToPath(new URL('../bin/nortuscc.mjs', import.meta.url));

function usage() {
  return execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
}

test('--help prints the usage text and exits 0', () => {
  const out = usage();
  assert.match(out, /Usage: nortuscc <command> \[options\]/);
  for (const verb of ['setup', 'status', 'apply', 'capture', 'pull', 'push']) {
    assert.match(out, new RegExp(`\\b${verb}\\b`), `usage should list ${verb}`);
  }
});

// I2: the usage text advertised `apply [--take-repo|--take-local]` and
// `capture [--take-repo|--take-local]`, but each command refuses the flag that
// runs against its own direction with exit 2. Advertising a combination the
// CLI itself rejects is worse than saying nothing.
test('usage advertises only the direction each command actually accepts', () => {
  const out = usage();

  assert.match(out, /apply[^\n]*--take-repo/, 'apply resolves a conflict in the repo\'s favour');
  assert.match(out, /capture[^\n]*--take-local/, 'capture resolves a conflict in the machine\'s favour');

  assert.doesNotMatch(
    out,
    /apply[^\n]*--take-local/,
    'apply --take-local exits 2 with a refusal, so usage must not advertise it',
  );
  assert.doesNotMatch(
    out,
    /capture[^\n]*--take-repo/,
    'capture --take-repo exits 2 with a refusal, so usage must not advertise it',
  );
});

// --check --yes is refused by update itself with exit 2 and its own message,
// which proves dispatch reached the command rather than the unknown-verb
// guard. It is also the only flag pair that cannot touch the network. The
// assertion checks for --check rather than the exact refusal wording, since
// that wording has already changed once and this test's job is only to prove
// dispatch reached the command module.
test('update is a known verb', () => {
  assert.throws(
    () => execFileSync(process.execPath, [BIN, 'update', '--check', '--yes'], { encoding: 'utf8' }),
    (e) => {
      assert.ok(!e.stderr.includes("unknown command 'update'"), 'update must reach its command module');
      assert.match(e.stderr, /--check/);
      assert.equal(e.status, 2);
      return true;
    },
  );
});

test('usage lists update', () => {
  const out = usage();
  assert.match(out, /update \[--check\]/);
});

test('usage documents the action flags', () => {
  const out = usage();
  assert.match(out, /--add/);
  assert.match(out, /--prune/);
});
