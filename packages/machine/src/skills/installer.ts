import { Effect } from 'effect';
import { normalizeSkillSource, type Target } from '@nortuscc/profile-engine';
import type { LaunchFailed } from '../errors.ts';
import type { StepResult } from '../model.ts';
import { Processes, type Command } from '../processes.ts';
import { isSkillCandidateSelector } from './candidates.ts';

// The only place `npx skills` is spelled. nortuscc's target names are not the installer's agent ids.
export const SKILL_AGENTS: Record<Target, string> = { claude: 'claude-code', codex: 'codex' };
export const SKILLS_CLI_VERSION = '1.7.2';

// Supplies the accepted ref to the audited vendor. SHA-looking branches/tags can win its checkout;
// the driver must verify accepted path/content before success. Legacy commands retain their version.
export const additionCommand = (input: {
  readonly source: string;
  readonly revision: string;
  readonly selectorName: string;
  readonly targets: ReadonlyArray<Target>;
}): Command => {
  if (normalizeSkillSource(input.source) !== input.source || !/^[0-9a-f]{40}$/.test(input.revision)
    || !isSkillCandidateSelector(input.selectorName) || !input.targets.length
    || input.targets.some(t => t !== 'claude' && t !== 'codex')) throw new Error('invalid skill addition command');
  return {
    cmd: 'npx',
    args: ['-y', `skills@${SKILLS_CLI_VERSION}`, 'add', `https://github.com/${input.source}/tree/${input.revision}`,
      '--skill', input.selectorName, '--agent', ...input.targets.map(t => SKILL_AGENTS[t]), '--global', '--yes'],
    output: 'inherit',
  };
};

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

export const removeCommand = (names: ReadonlyArray<string>, targets?: ReadonlyArray<Target>): Command =>
  ({ cmd: 'npx', args: ['-y', 'skills', 'remove', ...names, ...(targets ? ['--agent', ...targets.map(t => SKILL_AGENTS[t])] : []), '--global', '--yes'], output: 'inherit' });

// The installer's output, without colour codes, box drawing or status glyphs, as trimmed non-empty lines.
const outputLines = (text: string): string[] => text
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]/g, '')
  .replace(/[\u2190-\u21ff\u2500-\u27bf]/g, ' ')
  .split(/\r?\n|\r/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
const ERROR_LINE = /\b(error|err!|fail(ed|ure)?|fatal|denied|not found|no matching|unable|cannot|could not|invalid|enoent|eacces|eperm|etimedout|enotfound|econn\w*)\b/i;

// Why an installer exited non-zero, in words. "No matching skills found for: a, b" names the skills its
// source no longer has; otherwise the last error-looking line, else the last line, with the exit code.
export const installerFailure = (code: number, output: string, source?: string): { readonly note: string; readonly missing: readonly string[] } => {
  const lines = outputLines(output);
  for (const line of lines) {
    const match = /no matching skills? found for:?\s*(.+)$/i.exec(line);
    const missing = match ? [...new Set(match[1]!.split(/[,\s]+/).map(n => n.replace(/^['"`]+|['"`.]+$/g, '')).filter(Boolean))] : [];
    if (missing.length) return { missing, note: `${source ?? 'The source'} no longer has ${missing.join(', ')}. Remove ${missing.length > 1 ? 'them' : 'it'} from your profile's skills, then apply again.` };
  }
  const line = [...lines].reverse().find(l => ERROR_LINE.test(l)) ?? lines.at(-1);
  const reason = line === undefined ? '' : [...line].length > 300 ? `${[...line].slice(0, 299).join('')}…` : line;
  return { missing: [], note: reason ? `${reason} (npx exited with ${code})` : `npx exited with ${code}` };
};

// Shows the installer's output where `inherit` would and keeps its tail, so a failed note says why.
// `source` names the skills' source in a note about skills it no longer has; `missing` lists them.
export const runInstaller = (command: Command, source?: string): Effect.Effect<StepResult & { readonly missing?: readonly string[] }, LaunchFailed, Processes> =>
  Effect.gen(function* () {
    const { code, stdout, stderr } = yield* (yield* Processes).run({ ...command, output: 'tee' });
    if (code === 0) return { ok: true, note: '' };
    const failure = installerFailure(code, `${stdout}\n${stderr ?? ''}`, source);
    return { ok: false, note: failure.note, ...(failure.missing.length ? { missing: failure.missing } : {}) };
  });
