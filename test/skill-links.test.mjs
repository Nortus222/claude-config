import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentSkillsDir, exposedSkillNames, readLinkExposure } from '../src/skill-links.mjs';

// Each test gets its own ~/.claude and ~/.codex through the same env overrides
// the rest of the suite uses, so nothing here reads the developer's machine.
function onIsolatedAgents(prefix, fn) {
  const home = mkdtempSync(join(tmpdir(), `nortuscc-${prefix}-`));
  const claude = join(home, '.claude');
  const codex = join(home, '.codex');
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });

  const saved = { claude: process.env.NORTUSCC_CLAUDE_DIR, codex: process.env.NORTUSCC_CODEX_DIR };
  process.env.NORTUSCC_CLAUDE_DIR = claude;
  process.env.NORTUSCC_CODEX_DIR = codex;

  try {
    return fn({ home, claude, codex });
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = saved.claude;
    process.env.NORTUSCC_CODEX_DIR = saved.codex;
    rmSync(home, { recursive: true, force: true });
  }
}

test('the skills directory is the agent directory the rest of the tool already resolves', () => {
  onIsolatedAgents('links-dir', (fx) => {
    assert.equal(agentSkillsDir('claude'), join(fx.claude, 'skills'));
    assert.equal(agentSkillsDir('codex'), join(fx.codex, 'skills'));
  });
});

// The installer places a skill either way — it copied `wayfinder` into
// ~/.claude/skills as a directory while older entries are symlinks into the
// shared store — so both have to count as exposed.
test('a skill counts as exposed whether it was copied or linked', () => {
  onIsolatedAgents('links-both-shapes', (fx) => {
    const store = join(fx.home, '.agents', 'skills', 'linked');
    mkdirSync(store, { recursive: true });
    const skills = join(fx.claude, 'skills');
    mkdirSync(join(skills, 'copied'), { recursive: true });
    symlinkSync(store, join(skills, 'linked'));

    assert.deepEqual(exposedSkillNames('claude'), ['copied', 'linked']);
  });
});

// Codex keeps its built-in skills in `.system` beside the installed ones.
// Counting that as a shared skill would report a skill the manifest never
// named, and hide it from the store-side reconcile that should own it.
test('the agent\'s own dot-prefixed bookkeeping is not a shared skill', () => {
  onIsolatedAgents('links-dotfiles', (fx) => {
    const skills = join(fx.codex, 'skills');
    mkdirSync(join(skills, '.system'), { recursive: true });
    mkdirSync(join(skills, 'review'), { recursive: true });

    assert.deepEqual(exposedSkillNames('codex'), ['review']);
  });
});

// A link whose store entry was pruned still appears in readdir. The agent
// cannot load it, so neither can it count as exposed.
test('a link whose store entry is gone does not count as exposed', () => {
  onIsolatedAgents('links-broken', (fx) => {
    const skills = join(fx.claude, 'skills');
    mkdirSync(skills, { recursive: true });
    const store = join(fx.home, '.agents', 'skills', 'pruned');
    mkdirSync(store, { recursive: true });
    symlinkSync(store, join(skills, 'pruned'));
    rmSync(store, { recursive: true, force: true });

    assert.deepEqual(exposedSkillNames('claude'), []);
  });
});

test('an agent that has never had a skill placed exposes none', () => {
  onIsolatedAgents('links-absent', () => {
    assert.deepEqual(exposedSkillNames('claude'), []);
  });
});

test('exposure is keyed by installer agent id, not by nortuscc target', () => {
  onIsolatedAgents('links-keys', (fx) => {
    mkdirSync(join(fx.claude, 'skills', 'review'), { recursive: true });
    mkdirSync(join(fx.codex, 'skills'), { recursive: true });

    const { list, errors } = readLinkExposure(['claude-code', 'codex']);
    assert.deepEqual(errors, []);
    assert.deepEqual(list, { 'claude-code': ['review'], codex: [] });
  });
});

// The regression this module exists for. `npx skills list` answered from its
// lockfile and reported this skill as visible to both agents, so status called
// the machine clean while the skill was loadable by neither.
test('a skill in the store that reached no agent is exposed to no agent', () => {
  onIsolatedAgents('links-store-only', (fx) => {
    mkdirSync(join(fx.home, '.agents', 'skills', 'wayfinder'), { recursive: true });
    mkdirSync(join(fx.claude, 'skills'), { recursive: true });
    mkdirSync(join(fx.codex, 'skills'), { recursive: true });

    const { list } = readLinkExposure(['claude-code', 'codex']);
    assert.deepEqual(list, { 'claude-code': [], codex: [] });
  });
});

// agentDir throws on a target it does not know. Letting that escape would fail
// the whole status run over one unrecognised agent id.
test('an agent with no known directory is an error, not an empty list', () => {
  onIsolatedAgents('links-unknown-agent', () => {
    const { list, errors } = readLinkExposure(['cursor']);
    assert.deepEqual(list, {});
    assert.equal(errors.length, 1);
    assert.match(errors[0], /cursor/);
  });
});

// A file where a skill directory belongs is not a skill, but it is also not a
// crash: readdir still lists it and existsSync still resolves it.
test('a stray file in the skills directory is reported rather than throwing', () => {
  onIsolatedAgents('links-stray-file', (fx) => {
    const skills = join(fx.claude, 'skills');
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(skills, 'README.md'), '# not a skill');
    mkdirSync(join(skills, 'review'), { recursive: true });

    assert.deepEqual(exposedSkillNames('claude'), ['README.md', 'review']);
  });
});
