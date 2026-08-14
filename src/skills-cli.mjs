import { spawn } from 'node:child_process';
import { selectedTargets } from './targets.mjs';

// The only place `npx skills` is invoked. Everything else in the CLI deals in
// skill names and sources, so a change to the skills CLI's flags is contained here.

// nortuscc's target names are not the installer's agent ids. Mapped in exactly
// one place, so a rename upstream is one edit rather than a search.
export const SKILL_AGENTS = { claude: 'claude-code', codex: 'codex' };

export function agentIdsFor(target) {
  return selectedTargets(target).map((name) => SKILL_AGENTS[name]);
}

// --skill restores a precise subset rather than everything a repo publishes;
// --global keeps skills in ~/.agents/skills rather than a project directory.
//
// The names go in space-separated, not comma-joined. `--skill` is variadic —
// its own help example is `--skill pr-review commit` — so a comma-joined value
// is taken as one literal skill name. That failed silently-ish: the CLI
// reported "No matching skills found for: a,b,c" and then listed every one of
// them as available, which reads as the repo being wrong rather than the
// argument. Single-skill installs were unaffected, which is why it survived.
// The variadic stops at the next flag, so --global and --yes still land.
// `--agent` is variadic in the same way, and naming the agents explicitly is
// the point: left off, the installer decides which agents receive the skill,
// which is exactly the guess --target exists to replace.
export function buildCommand({ source, skills, agents = [] }) {
  return {
    cmd: 'npx',
    args: [
      '-y', 'skills', 'add', source,
      '--skill', ...skills,
      ...(agents.length ? ['--agent', ...agents] : []),
      '--global', '--yes',
    ],
  };
}

// `skills list --agent <id>` is deliberately not wrapped here. It answers from
// the installer's lockfile rather than the filesystem, returning every
// globally installed skill whichever agent is named, so it cannot answer "can
// this agent load this skill?" — see src/skill-links.mjs, which reads the
// agent's own directory instead.

function runOne({ cmd, args }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    // A non-zero exit is the install itself failing, already visible through
    // the child's inherited stderr — nothing more to say here.
    child.on('close', (code) => resolve(code === 0));
    // An 'error' here means the child never launched at all (e.g. ENOENT —
    // `npx` not on PATH), so stdio: 'inherit' had nothing to show. That is
    // silent otherwise, so it gets its own diagnostic.
    child.on('error', (err) => {
      console.error(`nortuscc: could not launch \`${cmd}\`: ${err.message}`);
      resolve(false);
    });
  });
}

export async function installGroups(groups, { agents = [], dryRun = false, run = runOne } = {}) {
  const results = [];
  for (const group of groups) {
    const command = buildCommand({ ...group, agents: group.agents ?? agents });
    if (dryRun) {
      console.log(`  ${command.cmd} ${command.args.join(' ')}`);
      results.push({ source: group.source, ok: true });
      continue;
    }
    console.log(`\ninstalling ${group.skills.length} skill(s) from ${group.source}`);
    results.push({ source: group.source, ok: await run(command) });
  }
  return results;
}

// `update` takes a bare name list, where `add --skill` takes one comma-joined
// value. Naming every skill keeps the batch to exactly what was confirmed,
// rather than everything installed globally. --yes skips the scope prompt,
// which is the only prompt this command has.
export function buildUpdateCommand(names) {
  return {
    cmd: 'npx',
    args: ['-y', 'skills', 'update', ...names, '--global', '--yes'],
  };
}

export async function runUpdate(names, { dryRun = false, run = runOne } = {}) {
  if (names.length === 0) return true;
  const command = buildUpdateCommand(names);
  if (dryRun) {
    console.log(`  ${command.cmd} ${command.args.join(' ')}`);
    return true;
  }
  console.log(`\nupdating ${names.length} skill(s)`);
  return run(command);
}

// `remove` takes bare positional names, the same shape as `update` and unlike
// `add --skill one,two`. --yes suppresses its confirmation prompt; nortuscc has
// already asked, and has already copied the folders into ~/.claude/backups/.
export function buildRemoveCommand(names) {
  return {
    cmd: 'npx',
    args: ['-y', 'skills', 'remove', ...names, '--global', '--yes'],
  };
}

export async function runRemove(names, { dryRun = false, run = runOne } = {}) {
  if (names.length === 0) return true;
  const command = buildRemoveCommand(names);
  if (dryRun) {
    console.log(`  ${command.cmd} ${command.args.join(' ')}`);
    return true;
  }
  console.log(`\nremoving ${names.length} skill(s)`);
  return run(command);
}
