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

// One agent per invocation: the installer answers for the agent it is asked
// about, and merging two agents' answers from a single call would lose which
// of them could actually see each skill.
export function buildListCommand(agent) {
  return {
    cmd: 'npx',
    args: ['-y', 'skills', 'list', '--global', '--agent', agent, '--json'],
  };
}

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

// Captures stdout rather than inheriting it: `list --json` is read, not shown.
function captureOne({ cmd, args }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('close', (code) => resolve({ ok: code === 0, stdout }));
    child.on('error', (err) => resolve({ ok: false, stdout: '', note: `could not launch \`${cmd}\`: ${err.message}` }));
  });
}

// The installer's own answer to "can this agent use this skill?". Accepts
// either `{skills: [{name}]}` or a bare array of names, since the shape is
// the installer's to change.
function parseNames(text) {
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : parsed?.skills;
  if (!Array.isArray(rows)) throw new Error('expected a list of skills');
  return rows.map((row) => (typeof row === 'string' ? row : row?.name)).filter((n) => typeof n === 'string');
}

// Output that cannot be parsed is an inspection error, never an empty list.
// Reading a failed read as "this agent has no skills" would report every
// shared skill as partially installed and drive a reinstall of all of them.
export async function readExposure(agents, { run = captureOne } = {}) {
  const list = {};
  const errors = [];

  for (const agent of agents) {
    const result = await run(buildListCommand(agent));
    if (!result?.ok) {
      errors.push(`could not list skills for ${agent}${result?.note ? `: ${result.note}` : ''}`);
      continue;
    }
    try {
      list[agent] = parseNames(result.stdout ?? '');
    } catch (err) {
      errors.push(`could not read the skill list for ${agent}: ${err.message}`);
    }
  }

  return { list, errors };
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
