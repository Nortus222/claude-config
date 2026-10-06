import { TARGETS, type MachineOverrides, type Target } from '@nortuscc/profile-engine';

// Whether this machine lets nortuscc manage agent configuration at all. A machine that installed
// this CLI for its skill set alone keeps its own rules and provider files. Integrations and skills
// stay managed either way; the line is drawn at configuration files. The choice lives in
// overrides.json as `manageConfig` and `configTargets`.

// Parsed before each command's own flags, exactly like --target: these are global, and a command
// that never heard of them must not report them as unknown options.
export const SKILLS_ONLY = '--skills-only';
export const WITH_CONFIG_ALWAYS = '--no-skills-only';
export const WITH_CONFIG_ONCE = '--with-config';

// The row every command prints in place of its config section, so "not managed here" can never be
// mistaken for "managed and clean".
export const SKIPPED_LABEL = 'configuration';
export const SKIPPED_STATE = 'skills-only';
export const SKIPPED_NOTE = 'not managed on this machine';

// `persist`: true records skills-only, false records config managed again, null records nothing.
// `once`: this run manages both agents' configuration without recording it.
export type ConfigMode = { rest: string[]; persist: boolean | null; once: boolean };

export function parseConfigMode(args: string[]): ConfigMode {
  const rest: string[] = [];
  let once = false;
  let persist: boolean | null = null;
  for (const arg of args) {
    if (arg === WITH_CONFIG_ONCE) once = true;
    else if (arg === SKILLS_ONLY) persist = true;
    else if (arg === WITH_CONFIG_ALWAYS) persist = false;
    else rest.push(arg);
  }
  return { rest, persist, once };
}

const withoutConfigChoice = ({ manageConfig: _m, configTargets: _t, ...rest }: MachineOverrides): MachineOverrides => rest;

// What this run manages, from the recorded overrides and the flags. A flag that sets the mode also
// takes effect on the run that sets it. `overrides` is what this run passes to `loadProfile`, so
// the engine's `managed` on each file reflects the run's choice.
export function resolveConfigMode(mode: ConfigMode, overrides: MachineOverrides):
  { manageConfig: boolean; configTargets: Target[]; overrides: MachineOverrides } {
  const run = mode.once || mode.persist === false
    ? withoutConfigChoice(overrides)
    : mode.persist === true ? { ...overrides, manageConfig: false } : overrides;
  return {
    manageConfig: run.manageConfig !== false,
    configTargets: [...(run.configTargets ?? TARGETS)],
    overrides: run,
  };
}

// The overrides document to persist for `mode`, or undefined when the run records nothing.
export function persisted(mode: ConfigMode, recorded: MachineOverrides): MachineOverrides | undefined {
  if (mode.persist === null) return undefined;
  return mode.persist ? { ...recorded, manageConfig: false } : { ...withoutConfigChoice(recorded), manageConfig: true };
}
