import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { RepoNotFound } from './errors.ts';

// Every machine location the package touches. Built once, at the boundary, from the environment.
export type MachinePathsValue = {
  readonly repo: string;
  readonly claude: string;
  readonly codex: string;
  readonly codexOpenRouter: string;
  readonly agentsSkills: string;
  readonly stateRoot: string;
  readonly backups: string;
};

export class MachinePaths extends Context.Service<MachinePaths, MachinePathsValue>()('machine/MachinePaths') {}

export const machinePaths = (value: MachinePathsValue) => Layer.succeed(MachinePaths, value);

export type PathsEnvironment = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly fallbackRepo?: string;
  readonly warn?: (message: string) => void;
};

// `.git` is a directory in a clone and a file in a linked worktree; both count.
export const isGitCheckout = (path: string | undefined): boolean =>
  Boolean(path) && existsSync(path!) && existsSync(join(path!, '.git'));

const recordedRepo = (paths: readonly string[]): string | undefined => {
  for (const path of paths) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed.repo === 'string' && parsed.repo) return parsed.repo;
    } catch {
      // Absent or corrupt: try the next record.
    }
  }
  return undefined;
};

// Resolves today's NORTUSCC_* and HOME rules into explicit paths, so nothing below reads the environment.
export const pathsFromEnvironment = (input: PathsEnvironment): Effect.Effect<MachinePathsValue, RepoNotFound> =>
  Effect.suspend(() => {
    const { env, home, platform } = input;
    const claude = env.NORTUSCC_CLAUDE_DIR || join(home, '.claude');
    const codex = env.NORTUSCC_CODEX_DIR || join(home, '.codex');
    const codexOpenRouter = env.NORTUSCC_OPENROUTER_CODEX_DIR
      || (env.NORTUSCC_CODEX_DIR ? join(dirname(env.NORTUSCC_CODEX_DIR), '.codex-openrouter') : join(home, '.codex-openrouter'));
    const stateRoot = env.NORTUSCC_STATE_DIR
      || (platform === 'win32' ? join(env.APPDATA ?? '', 'nortuscc') : join(home, '.config', 'nortuscc'));

    let repo = env.NORTUSCC_REPO_DIR || undefined;
    let recorded: string | undefined;
    if (!repo) {
      recorded = recordedRepo([join(stateRoot, 'state.json'), join(claude, '.nortuscc-lock.json')]);
      if (recorded && isGitCheckout(recorded)) repo = recorded;
      else if (recorded && input.fallbackRepo) {
        input.warn?.(
          `nortuscc: recorded repo '${recorded}' is not a git checkout; using ${input.fallbackRepo} instead. `
            + "Re-run 'nortuscc setup --dir <path>' to fix the record.",
        );
      }
      repo ??= input.fallbackRepo;
    }
    if (!repo) return Effect.fail(new RepoNotFound({ recorded }));

    return Effect.succeed({
      repo,
      claude,
      codex,
      codexOpenRouter,
      agentsSkills: env.NORTUSCC_AGENTS_DIR || join(home, '.agents', 'skills'),
      stateRoot,
      backups: join(stateRoot, 'backups'),
    });
  });

// The one place an engine home becomes a directory.
export const homeDir = (paths: MachinePathsValue, home: 'claude' | 'codex' | 'codex-openrouter'): string =>
  home === 'claude' ? paths.claude : home === 'codex' ? paths.codex : paths.codexOpenRouter;
