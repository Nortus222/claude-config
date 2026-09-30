import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { confirm as ask } from './prompt.mjs';
import { spawnCommand, captureCommand } from './integrations/runner.mjs';

export const PREREQUISITES = [
  { id: 'git', label: 'Git', executables: ['git'], brew: 'git', winget: 'Git.Git', url: 'https://git-scm.com/downloads' },
  { id: 'node', label: 'Node.js, npm and npx', executables: ['node', 'npm', 'npx'], brew: 'node', winget: 'OpenJS.NodeJS.LTS', url: 'https://nodejs.org/en/download' },
  { id: 'gh', label: 'GitHub CLI', executables: ['gh'], brew: 'gh', winget: 'GitHub.cli', url: 'https://cli.github.com/', setup: { cmd: 'gh', args: ['auth', 'login'] } },
  { id: 'claude', label: 'Claude Code CLI', executables: ['claude'], brew: 'claude-code', cask: true, winget: 'Anthropic.ClaudeCode', url: 'https://code.claude.com/docs/en/setup', setup: { cmd: 'claude', args: ['auth', 'login'] } },
  { id: 'codex', label: 'Codex CLI', executables: ['codex'], brew: 'codex', cask: true, winget: 'OpenAI.Codex', url: 'https://github.com/openai/codex', setup: { cmd: 'codex', args: ['login'] } },
];

// Check PATH directly so Windows npm.cmd and agent .cmd shims count as installed.
export async function executableAvailable(command, { platform = process.platform, env = process.env } = {}) {
  const windows = platform === 'win32';
  const paths = (env.PATH ?? env.Path ?? '').split(windows ? ';' : path.delimiter);
  const extensions = windows ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  for (const directory of paths) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), `${command}${extension}`);
      try {
        await access(candidate, windows ? constants.F_OK : constants.X_OK);
        if ((await stat(candidate)).isFile()) return true;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return false;
}

// PowerShell launches Windows .cmd shims. Its script comes only from this fixed list.
export function prerequisiteCommand(command, platform = process.platform) {
  if (platform !== 'win32') return command;
  const scripts = new Map([
    ['gh auth login', '$tool = Get-Command gh -CommandType Application -ErrorAction Stop; & $tool.Source auth login; exit $LASTEXITCODE'],
    ['claude auth login', '$tool = Get-Command claude -CommandType Application -ErrorAction Stop; & $tool.Source auth login; exit $LASTEXITCODE'],
    ['codex login', '$tool = Get-Command codex -CommandType Application -ErrorAction Stop; & $tool.Source login; exit $LASTEXITCODE'],
  ]);
  const script = scripts.get([command.cmd, ...command.args].join(' '));
  return script ? { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', script] } : command;
}

// WinGet updates registry PATH without updating this process's environment.
export async function refreshPrerequisitePath({ platform = process.platform, env = process.env, capture = captureCommand } = {}) {
  if (platform !== 'win32') return true;
  const result = await capture({
    cmd: 'powershell.exe',
    args: ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')"],
  });
  if (!result?.ok) return false;
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  const directories = [...(env[key] ?? '').split(';'), ...(result.stdout ?? '').trim().split(';')];
  const seen = new Set();
  env[key] = directories.filter((directory) => {
    if (!directory || seen.has(directory.toLowerCase())) return false;
    seen.add(directory.toLowerCase());
    return true;
  }).join(';');
  return true;
}

function installCommand(tool, platform) {
  if (platform === 'darwin') return { cmd: 'brew', args: ['install', ...(tool.cask ? ['--cask'] : []), tool.brew] };
  if (platform === 'win32') return { cmd: 'winget', args: ['install', '--id', tool.winget, '--exact', '--source', 'winget'] };
  return null;
}

// Every install and login needs its own explicit confirmation, even under --yes.
export async function setupPrerequisites({
  isTTY = process.stdin.isTTY,
  confirm = ask,
  platform = process.platform,
  check = (command) => executableAvailable(command, { platform }),
  run = (command) => spawnCommand(prerequisiteCommand(command, platform)),
  refreshPath = () => refreshPrerequisitePath({ platform }),
  output = process.stdout,
  tools = PREREQUISITES,
} = {}) {
  if (!isTTY) return 0;
  let failed = false;
  const write = (message) => output.write(`${message}\n`);
  const available = async (tool) => {
    const checks = await Promise.all(tool.executables.map((command) => check(command)));
    return checks.every(Boolean);
  };

  write('Prerequisites: each installation and account setup is optional.');
  for (const tool of tools) {
    try {
      let installed = await available(tool);
      write(`${tool.label}: ${installed ? 'installed' : 'missing'}`);
      if (!installed) {
        const install = installCommand(tool, platform);
        const commandLabel = install ? `${install.cmd} ${install.args.join(' ')}` : tool.url;
        if (await confirm(`Install ${tool.label} using ${commandLabel}?`, { isTTY }) !== true) continue;
        if (!install) {
          write(`Install ${tool.label} manually: ${tool.url}`);
          failed = true;
          continue;
        }
        if (!await check(install.cmd)) {
          write(platform === 'darwin'
            ? 'Homebrew is missing. Install it from https://brew.sh, then restart this setup.'
            : 'WinGet is missing. Install App Installer from https://learn.microsoft.com/windows/package-manager/winget, then restart this setup.');
          failed = true;
          continue;
        }
        const result = await run(install);
        if (!result?.ok) {
          write(`${tool.label} installation failed: ${result?.note || 'command failed'}`);
          failed = true;
          continue;
        }
        await refreshPath();
        installed = await available(tool);
        if (!installed) {
          write(`${tool.label} is still unavailable. Restart your terminal so PATH includes the install directory, then run setup again. See ${tool.url}`);
          failed = true;
          continue;
        }
      }
      if (tool.setup && await confirm(`Set up ${tool.label} now using ${tool.setup.cmd} ${tool.setup.args.join(' ')}?`, { isTTY }) === true) {
        const result = await run(tool.setup);
        if (!result?.ok) {
          write(`${tool.label} setup failed: ${result?.note || 'command failed'}`);
          failed = true;
        }
      }
    } catch (err) {
      write(`${tool.label} failed: ${err.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}
