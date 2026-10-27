import { TARGETS, type Input, type MachineOverrides, type Target } from '@nortuscc/profile-engine';

// The agent targets this machine's choices set up: none while the choices are invalid or the
// configuration is unmanaged, every target when none was chosen, and none before the first inspection.
export const configuredTargets = (choices: Input<MachineOverrides>, inspected: boolean): readonly Target[] =>
  choices.issues.length || choices.value.manageConfig === false ? [] : choices.value.configTargets ?? (inspected ? TARGETS : []);
