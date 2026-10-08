import { Schema } from 'effect';
export const HealthResponseSchema = Schema.Struct({ status: Schema.Literal('ok') });
export type HealthResponse = typeof HealthResponseSchema.Type;
