import { Effect } from 'effect';
import type { Backups } from '../backups.ts';
import type { Fs } from '../fs.ts';
import type { Domain, StepResult } from '../model.ts';
import type { MachinePaths } from '../paths.ts';
import type { StateStore } from '../state.ts';
import { inspectConfig } from './inspect.ts';
import { configSteps } from './steps.ts';
import { restoreFile } from './restore.ts';
import { syncFile } from './sync.ts';

export { CHANGED_SINCE_APPLY } from './steps.ts';

const SYNC_ACTIONS = new Set(['write-file', 'merge-keys', 'capture-file']);

// Copied files and settings keys from `DesiredConfig.files`.
export const configDomain: Domain<MachinePaths | Fs | StateStore | Backups> = {
  name: 'config',
  inspect: inspectConfig,
  steps: configSteps,
  run: (step, report) =>
    step.action === 'restore' ? restoreFile(step, report)
      : SYNC_ACTIONS.has(step.action) ? syncFile(step, report)
      : Effect.succeed<StepResult>({ ok: false, note: `config does not run ${step.action}` }),
};
