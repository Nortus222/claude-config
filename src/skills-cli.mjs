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
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
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
