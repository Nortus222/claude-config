import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Asserts a direct child was reaped by this process: its PID no longer exists.
export const assertReaped = (pid: number, message: string) =>
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, message);

// Asserts a grandchild has exited. Once orphaned, it is reaped by init or launchd on their schedule,
// so it may still be a zombie (Z) or exiting (macOS E) after its group was killed and joined.
export const assertExited = (pid: number, message: string) => {
  try { process.kill(pid, 0); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH', message); return; }
  let stat: string;
  try { stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return; } // reaped meanwhile
  assert.match(stat, /[ZXE]/, `${message} (state ${stat})`);
};
