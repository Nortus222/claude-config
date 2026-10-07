import { Schema } from 'effect';

export const ERROR_STATUS = {
  unauthenticated: 401,
  not_allowlisted: 403,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  payload_too_large: 413,
  revision_conflict: 409,
  status_disabled: 409,
  limit_reached: 409,
  sign_in_expired: 410,
  rate_limited: 429,
  unavailable: 503,
} as const;
export const ERROR_CODES = Object.keys(ERROR_STATUS) as (keyof typeof ERROR_STATUS)[];
export const ErrorCodeSchema = Schema.Literals(ERROR_CODES);
export type ErrorCode = typeof ErrorCodeSchema.Type;
export const ErrorResponseSchema = Schema.Struct({ error: ErrorCodeSchema, message: Schema.String });
export type ErrorResponse = typeof ErrorResponseSchema.Type;
