import { readLock } from './lock.mjs';

// Whether this machine lets nortuscc manage agent configuration at all. A
// machine that installed this CLI for its skill set alone keeps its own rules
// and provider files; syncing them would overwrite user-owned configuration.
//
// Integrations stay managed either way. The line is drawn at configuration
// files; `--no-hooks`,
// `--no-mcp` and `--no-plugins` already decline the rest per install.
//
// This reverses install.mjs's original "configuration is never filtered, and
// declining an agent's configuration is what --target is for". That held while
// the repo had one user: --target picks *which* agent, never *whether*, so it
// could not express "this machine, neither agent, ever".

// Parsed before each command's own flags, exactly like --target: these are
// global, and a command that never heard of them must not report them as
// unknown options.
export const SKILLS_ONLY = '--skills-only';
export const WITH_CONFIG_ALWAYS = '--no-skills-only';
export const WITH_CONFIG_ONCE = '--with-config';

// `persist` is the setting to record, or null to leave the recorded one alone.
// `manageConfig` is what this run does, which the one-off override can widen
// without changing what the next run will do.
export function parseConfigMode(allArgs, { recorded } = {}) {
  const rest = [];
  let once = false;
  let persist = null;

  for (const arg of allArgs) {
    if (arg === WITH_CONFIG_ONCE) { once = true; continue; }
    if (arg === SKILLS_ONLY) { persist = true; continue; }
    if (arg === WITH_CONFIG_ALWAYS) { persist = false; continue; }
    rest.push(arg);
  }

  // A flag that sets the mode also takes effect on the run that sets it, so
  // `setup --skills-only` never writes a configuration file on its way to
  // recording that it should not.
  const skillsOnly = persist ?? recorded ?? readLock().skillsOnly === true;

  return { rest, persist, skillsOnly, manageConfig: once || !skillsOnly };
}

// The row every command prints in place of its config section, so "not managed
// here" can never be mistaken for "managed and clean".
export const SKIPPED_LABEL = 'configuration';
export const SKIPPED_STATE = 'skills-only';
export const SKIPPED_NOTE = 'not managed on this machine';
