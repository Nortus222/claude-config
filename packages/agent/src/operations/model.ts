import type { Schema } from 'effect';
import type { OperationScopeSchema, CapabilityStateSchema, ContextResultSchema, ChangePreviewSchema, RunViewSchema, NextActionSchema, ReconcileChangeSchema } from './schemas.ts';

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
