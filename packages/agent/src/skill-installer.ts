import { isAbsolute, join, normalize } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { additionCommand, type Command, type MachinePathsValue } from '@nortuscc/machine';

export class SkillInstallUnavailable extends Error {
  readonly code = 'SKILL_INSTALL_UNAVAILABLE';
  constructor() { super('Native skill installer destination mapping is unavailable; check the explicit home, shared store and native lock location'); }
}
export class AgentSkillInstaller extends Context.Service<AgentSkillInstaller, {
  readonly prepare: (paths: MachinePathsValue, input: Parameters<typeof additionCommand>[0]) => Effect.Effect<Command, SkillInstallUnavailable>;
}>()('agent/SkillInstaller') {}

// Vendor 1.7.2 fixes the shared store to homedir/.agents/skills. Native config roots are configurable.
// No home inference or ambient environment lookup occurs below the entry layer.
export const agentSkillInstaller = (options?: { readonly home: string; readonly xdgStateHome?: string }) => Layer.succeed(AgentSkillInstaller, {
  prepare: (paths, input) => Effect.try({ try: () => {
    if (!options || !isAbsolute(options.home) || options.home.includes('\0') || options.xdgStateHome
      || normalize(paths.agentsSkills) !== join(options.home, '.agents', 'skills')
      || [paths.claude, paths.codex].some(p => !isAbsolute(p) || p.trim() !== p || p.includes('\0'))) throw new SkillInstallUnavailable();
    return { ...additionCommand(input), cwd: paths.stateRoot,
      envAllow: ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP'],
      env: { HOME: options.home, USERPROFILE: options.home, CLAUDE_CONFIG_DIR: paths.claude, CODEX_HOME: paths.codex, XDG_STATE_HOME: '' } };
  }, catch: () => new SkillInstallUnavailable() }),
});
