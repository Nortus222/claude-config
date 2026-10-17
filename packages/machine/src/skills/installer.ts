import { Effect } from 'effect';
import { normalizeSkillSource, type Target } from '@nortuscc/profile-engine';
import type { LaunchFailed } from '../errors.ts';
import type { StepResult } from '../model.ts';
import { Processes, type Command } from '../processes.ts';
import { isSkillCandidateSelector } from './candidates.ts';
import { short } from './pins.ts';

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

// A name the installer takes as one `--skill` value and echoes back unambiguously: no whitespace or
// commas (its errors join names with ", "), and no leading dash (it would read as a flag).
const INSTALLER_SKILL_NAME = /^[^\s,-][^\s,]*$/;

// `--skill` and `--agent` are variadic: names go in space-separated (a comma-joined value is one literal
// name). Agents are always explicit, so the installer never guesses which agents get the skill.
// Throws on a skill name the installer cannot take as one value.
export const addCommand = (input: {
  readonly source: string;
  readonly skills: ReadonlyArray<string>;
  readonly targets: ReadonlyArray<Target>;
}): Command => {
  const bad = input.skills.find((n) => !INSTALLER_SKILL_NAME.test(n));
  if (bad !== undefined) throw new Error(`Skill name "${bad}" can't be installed: skill names have no spaces, commas or leading dash`);
  return {
    cmd: 'npx',
    args: ['-y', 'skills', 'add', input.source, '--skill', ...input.skills,
      ...(input.targets.length ? ['--agent', ...input.targets.map((t) => SKILL_AGENTS[t])] : []), '--global', '--yes'],
    output: 'inherit',
  };
};

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

// Why a step failed when `source` lacks requested skills. At a pin the skill may simply be newer than the pin.
export const missingSkillsNote = (source: string, missing: readonly string[], pin?: string): string => {
  const them = missing.length > 1 ? 'them' : 'it';
  return pin
    ? `${source} at ${short(pin)} doesn't have ${missing.join(', ')}. Move the pin to a commit that has ${them}, or remove ${them} from your profile's skills, then apply again.`
    : `${source} no longer has ${missing.join(', ')}. Remove ${them} from your profile's skills, then apply again.`;
};

// Why an installer exited non-zero, in words. It exits 1 with "No matching skills found for: a, b", naming
// every requested skill, only when none of them match (some matching exits 0 and skips the rest); otherwise
// the last error-looking line, else the last line, with the exit code. `pin` is the commit `source` was asked at.
export const installerFailure = (code: number, output: string, source?: string, pin?: string): { readonly note: string; readonly missing: readonly string[] } => {
  const lines = outputLines(output);
  for (const line of lines) {
    const match = /no matching skills? found for:?\s*(.+)$/i.exec(line);
    // Names are requested as separate values without spaces or commas, and echoed joined with ", ".
    const missing = match ? [...new Set(match[1]!.split(/[,\s]+/).map(n => n.replace(/^['"`]+|['"`.]+$/g, '')).filter(Boolean))] : [];
    if (missing.length) return { missing, note: missingSkillsNote(source ?? 'The source', missing, pin) };
  }
  const line = [...lines].reverse().find(l => ERROR_LINE.test(l)) ?? lines.at(-1);
  const reason = line === undefined ? '' : [...line].length > 300 ? `${[...line].slice(0, 299).join('')}…` : line;
  return { missing: [], note: reason ? `${reason} (npx exited with ${code})` : `npx exited with ${code}` };
};

// Shows the installer's output where `inherit` would and keeps its tail, so a failed note says why.
// `source`, and the `pin` it was asked at, name the skills' source in a note about skills it lacks;
// `missing` lists them.
export const runInstaller = (command: Command, source?: string, pin?: string): Effect.Effect<StepResult & { readonly missing?: readonly string[] }, LaunchFailed, Processes> =>
  Effect.gen(function* () {
    const { code, stdout, stderr } = yield* (yield* Processes).run({ ...command, output: 'tee' });
    if (code === 0) return { ok: true, note: '' };
    const failure = installerFailure(code, `${stdout}\n${stderr ?? ''}`, source, pin);
    return { ok: false, note: failure.note, ...(failure.missing.length ? { missing: failure.missing } : {}) };
  });
