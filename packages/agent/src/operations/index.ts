import { Schema } from 'effect';
import type { OperationDefinition } from './model.ts';
import {
  GetContextInputSchema, ContextResultSchema, InspectInputSchema, InspectResultSchema,
  PreviewChangeInputSchema, ChangePreviewSchema, ApplyChangeInputSchema, ApplyChangeResultSchema,
  GetRunInputSchema, RunViewSchema, ListRunsInputSchema, RunListResultSchema, CancelRunInputSchema,
  HistoryInputSchema, OperationHistoryResultSchema,
} from './schemas.ts';

export * from './model.ts';
export * from './schemas.ts';
export * from './context.ts';
export * from './coverage.ts';

const define = <N extends string, I extends Schema.ConstraintDecoder<unknown>, O extends Schema.ConstraintDecoder<unknown>>(
  name: N, input: I, output: O, mutation = false,
): OperationDefinition<N, I, O> => ({ name, input, output, scopes: ['machine'], mutation });

export const operationDefinitions = {
  getContext: define('getContext', GetContextInputSchema, ContextResultSchema),
  inspect: define('inspect', InspectInputSchema, InspectResultSchema),
  previewChange: define('previewChange', PreviewChangeInputSchema, ChangePreviewSchema),
  applyChange: define('applyChange', ApplyChangeInputSchema, ApplyChangeResultSchema, true),
  getRun: define('getRun', GetRunInputSchema, RunViewSchema),
  listRuns: define('listRuns', ListRunsInputSchema, RunListResultSchema),
  cancelRun: define('cancelRun', CancelRunInputSchema, RunViewSchema, true),
  history: define('history', HistoryInputSchema, OperationHistoryResultSchema),
} as const;
export type OperationName = keyof typeof operationDefinitions;
export type OperationInput<N extends OperationName> = typeof operationDefinitions[N]['input']['Type'];
export type OperationOutput<N extends OperationName> = typeof operationDefinitions[N]['output']['Type'];
const strict = { onExcessProperty: 'error' } as const;
export const decodeOperationInput = <N extends OperationName>(name: N, input: unknown): OperationInput<N> =>
  Schema.decodeUnknownSync(operationDefinitions[name].input as Schema.ConstraintDecoder<unknown>, strict)(input) as OperationInput<N>;
export const decodeOperationOutput = <N extends OperationName>(name: N, output: unknown): OperationOutput<N> =>
  Schema.decodeUnknownSync(operationDefinitions[name].output as Schema.ConstraintDecoder<unknown>, strict)(output) as OperationOutput<N>;

const jsonSchema = (schema: Schema.Constraint) => {
  const document = Schema.toJsonSchemaDocument(schema, strict);
  return { ...document.schema, ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}) };
};
export const operationJsonSchemas = Object.fromEntries(Object.entries(operationDefinitions).map(([name, definition]) => [name, {
  input: jsonSchema(definition.input), output: jsonSchema(definition.output),
}])) as { readonly [N in OperationName]: { readonly input: ReturnType<typeof jsonSchema>; readonly output: ReturnType<typeof jsonSchema> } };
