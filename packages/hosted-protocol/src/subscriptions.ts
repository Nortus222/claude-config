import { Schema } from 'effect';
import { IdSchema, RevisionCursorSchema } from './primitives.ts';
import { SetupRegistrationSchema } from './revisions.ts';

export const PublicSetupSchema = Schema.Struct({ setupId: IdSchema, ...SetupRegistrationSchema.fields, latestRevision: RevisionCursorSchema });
export type PublicSetup = typeof PublicSetupSchema.Type;
