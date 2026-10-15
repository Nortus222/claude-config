import type { Schema } from 'effect';
import type { OperationScopeSchema, CapabilityStateSchema, ContextResultSchema, ChangePreviewSchema, RunViewSchema, NextActionSchema, ReconcileChangeSchema, AddSkillChangeSchema, ChangeSchema, SkillCandidateResultSchema } from './schemas.ts';

export type OperationScope = typeof OperationScopeSchema.Type;
export type CapabilityState = typeof CapabilityStateSchema.Type;
export type ContextResult = typeof ContextResultSchema.Type;
export type ChangePreview = typeof ChangePreviewSchema.Type;
export type RunView = typeof RunViewSchema.Type;
export type NextAction = typeof NextActionSchema.Type;
export type ReconcileChange = typeof ReconcileChangeSchema.Type;

export type OperationDefinition<Name extends string, Input extends Schema.ConstraintDecoder<unknown>, Output extends Schema.ConstraintDecoder<unknown>> = {
  readonly name: Name;
  readonly input: Input;
  readonly output: Output;
  readonly scopes: ReadonlyArray<OperationScope['kind']>;
  readonly mutation: boolean;
};

export type AddSkillChange = typeof AddSkillChangeSchema.Type;
export type OperationChange = typeof ChangeSchema.Type;
export type SkillCandidateResult = typeof SkillCandidateResultSchema.Type;

export type OperationStep = typeof import('./schemas.ts').OperationStepSchema.Type;
export type OperationPlan = typeof import('./schemas.ts').OperationPlanSchema.Type;
export type OperationProgress = typeof import('./schemas.ts').OperationProgressSchema.Type;
export type ParityAcceptance = typeof import('./schemas.ts').ParityAcceptanceSchema.Type;
export type ParityRunEvidence = typeof import('./schemas.ts').ParityRunEvidenceSchema.Type;

export type MachineIntentChange = typeof import('./schemas.ts').MachineIntentChangeSchema.Type;
export type MachineIntentPatch = typeof import('./schemas.ts').MachineIntentPatchSchema.Type;
