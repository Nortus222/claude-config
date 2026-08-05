import { spawn } from 'node:child_process';

// The only place `npx skills` is invoked. Everything else in the CLI deals in
// skill names and sources, so a change to the skills CLI's flags is contained here.

// --skill restores a precise subset rather than everything a repo publishes;
// --global keeps skills in ~/.agents/skills rather than a project directory.
export function buildCommand({ source, skills }) {
  return {
    cmd: 'npx',
    args: ['-y', 'skills', 'add', source, '--skill', skills.join(','), '--global', '--yes'],
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

export async function installGroups(groups, { dryRun = false } = {}) {
  const results = [];
  for (const group of groups) {
    const command = buildCommand(group);
    if (dryRun) {
      console.log(`  ${command.cmd} ${command.args.join(' ')}`);
      results.push({ source: group.source, ok: true });
      continue;
    }
    console.log(`\ninstalling ${group.skills.length} skill(s) from ${group.source}`);
    results.push({ source: group.source, ok: await runOne(command) });
  }
  return results;
}
