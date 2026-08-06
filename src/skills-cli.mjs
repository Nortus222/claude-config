import { spawn } from 'node:child_process';

// The only place `npx skills` is invoked. Everything else in the CLI deals in
// skill names and sources, so a change to the skills CLI's flags is contained here.

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
export function buildCommand({ source, skills }) {
  return {
    cmd: 'npx',
    args: ['-y', 'skills', 'add', source, '--skill', ...skills, '--global', '--yes'],
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

export async function installGroups(groups, { dryRun = false, run = runOne } = {}) {
  const results = [];
  for (const group of groups) {
    const command = buildCommand(group);
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
