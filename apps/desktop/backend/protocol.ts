import { Schema } from 'effect';

export const MAX_RECORD_BYTES = 16_384;
const Id = Schema.String.check(Schema.isBetweenLength(1, 100));
export const RequestSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Id,
  command: Schema.Literals(['inspect', 'start', 'cancel', 'shutdown', 'crash']),
});
export const ProgressSchema = Schema.Struct({
  version: Schema.Literal(1),
  event: Schema.Literal('progress'),
  operationId: Id,
  state: Schema.Literals(['running', 'completed', 'cancelled', 'failed']),
  percent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  detail: Schema.String.check(Schema.isMaxLength(500)),
});
export const ResponseSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    id: Id,
    ok: Schema.Literal(true),
    result: Schema.Unknown,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    id: Id,
    ok: Schema.Literal(false),
    error: Schema.Struct({ code: Id, message: Schema.String.check(Schema.isMaxLength(500)) }),
  }),
]);
const MessageSchema = Schema.Union([ProgressSchema, ResponseSchema]);
export const decodeRequest = Schema.decodeUnknownSync(RequestSchema, { onExcessProperty: 'error' });
export const decodeMessage = Schema.decodeUnknownSync(MessageSchema, { onExcessProperty: 'error' });
export type Request = typeof RequestSchema.Type;
export type Progress = typeof ProgressSchema.Type;
export type Response = typeof ResponseSchema.Type;
