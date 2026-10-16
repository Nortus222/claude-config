import { Schema } from 'effect';
import { ContextResultSchema } from './schemas.ts';

export const capabilityInventory = {
  listBackups: {available:true}, pruneBackups: {available:true},
  agentStatus: {available:true}, accountState: {available:true},
  setPolicy: {available:true}, resume: {available:true}, signIn: {available:true}, signOut: {available:true}, syncAccount: {available:true}, patchMachineMetadata: {available:true},
  sourceDecision: {available:true}, watchSources: {available:true}, inspectSourceDiff: {available:true}, pinImpact: {available:true}, draftChangelog: {available:true},
  setupReview: { available: true }, setupApply: { available: true },
  inspectSetups: { available: true }, incomingChanges: { available: true }, prepareTrustRequest: { available: true }, syncDecision: { available: true }, inspectUpdates: { available: true }, inspectIntent: { available: true }, machineIntent: { available: true }, getContext: { available: true }, inspect: { available: true }, previewChange: { available: true },
  applyChange: { available: true }, getRun: { available: true }, listRuns: { available: true },
  cancelRun: { available: true }, history: { available: true },
  resolveSkillCandidate: { available: true },
  addSkill: { available: true },
  shareWithMyMachines: { available: false, reason: 'Personal sharing requires an available distribution destination.' },
  promoteToProfile: { available: false, reason: 'Profile promotion requires owned-profile identity, an explicit destination and a verified publication workflow.' },
} as const;

// Project only modeled fields; runtime callers supply identity and prerequisite state.
export const projectContext = Schema.decodeUnknownSync(ContextResultSchema, { onExcessProperty: 'ignore' });
