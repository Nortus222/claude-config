import { Schema } from 'effect';
import { ContextResultSchema } from './schemas.ts';

export const capabilityInventory = {
  getContext: { available: true }, inspect: { available: true }, previewChange: { available: true },
  applyChange: { available: true }, getRun: { available: true }, listRuns: { available: true },
  cancelRun: { available: true }, history: { available: true },
  addSkill: { available: false, reason: 'Machine-local additions require the owning declaration model.' },
  shareWithMyMachines: { available: false, reason: 'Personal sharing requires an available distribution destination.' },
  promoteToProfile: { available: false, reason: 'Profile promotion requires the owning profile workflow.' },
} as const;

// Project only modeled fields; runtime callers supply identity and prerequisite state.
export const projectContext = Schema.decodeUnknownSync(ContextResultSchema, { onExcessProperty: 'ignore' });
