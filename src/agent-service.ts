import { spawnSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { MachinePathsValue } from '@nortuscc/machine';
import type { ServiceProgram, ServiceTarget } from '@nortuscc/agent';
import { CHECKOUT } from './machine.ts';

// Where and as whom this user's login service is registered; undefined on an unsupported platform.
// This is the CLI boundary, so it reads the process's own platform, home and user.
export function serviceTarget(paths: MachinePathsValue): ServiceTarget | undefined {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') return undefined;
  return { platform, home: homedir(), uid: process.getuid?.() ?? 0, user: userInfo().username, stateRoot: paths.stateRoot };
}

// What the service runs: this checkout's `nortuscc agent run`, with PATH and the installer's
// NORTUSCC_* variables (test-only ones excepted), so the agent resolves the same paths it was installed with.
export function agentProgram(paths: MachinePathsValue): ServiceProgram {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // Windows spells it Path; the unit always gets PATH.
    if (key.toUpperCase() === 'PATH') env.PATH = value;
    else if (key.startsWith('NORTUSCC_') && !key.startsWith('NORTUSCC_TEST_')) env[key] = value;
  }
  return {
    argv: [process.execPath, join(CHECKOUT, 'bin', 'nortuscc.mjs'), 'agent', 'run'],
    env,
    workingDirectory: CHECKOUT,
    logPath: join(paths.stateRoot, 'agent', 'agent.log'),
  };
}

// The checkout's HEAD commit, or 'unknown' when git cannot say.
export function checkoutVersion(): string {
  const result = spawnSync('git', ['-C', CHECKOUT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const head = result.status === 0 ? result.stdout.trim() : '';
  return head === '' ? 'unknown' : head;
}
