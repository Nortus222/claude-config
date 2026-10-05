import { Effect } from 'effect';
import type { Target } from '@nortuscc/profile-engine';
import type { LaunchFailed } from '../errors.ts';
import type { StepResult } from '../model.ts';
import { Processes, type Command } from '../processes.ts';

// The only place `npx skills` is spelled. nortuscc's target names are not the installer's agent ids.
export const SKILL_AGENTS: Record<Target, string> = { claude: 'claude-code', codex: 'codex' };

// `--skill` and `--agent` are variadic: names go in space-separated (a comma-joined value is one literal
// name). Agents are always explicit, so the installer never guesses which agents get the skill.
export const addCommand = (input: {
  readonly source: string;
  readonly skills: ReadonlyArray<string>;
  readonly targets: ReadonlyArray<Target>;
}): Command => ({
  cmd: 'npx',
  args: ['-y', 'skills', 'add', input.source, '--skill', ...input.skills,
    ...(input.targets.length ? ['--agent', ...input.targets.map((t) => SKILL_AGENTS[t])] : []), '--global', '--yes'],
  output: 'inherit',
});

export const updateCommand = (names: ReadonlyArray<string>): Command =>
  ({ cmd: 'npx', args: ['-y', 'skills', 'update', ...names, '--global', '--yes'], output: 'inherit' });

export const removeCommand = (names: ReadonlyArray<string>): Command =>
  ({ cmd: 'npx', args: ['-y', 'skills', 'remove', ...names, '--global', '--yes'], output: 'inherit' });

// The installer's own output is inherited, so a failure explains itself there; the note only names the exit.
export const runInstaller = (command: Command): Effect.Effect<StepResult, LaunchFailed, Processes> =>
  Effect.gen(function* () {
    const { code } = yield* (yield* Processes).run(command);
    return code === 0 ? { ok: true, note: '' } : { ok: false, note: `npx exited with ${code}` };
  });
