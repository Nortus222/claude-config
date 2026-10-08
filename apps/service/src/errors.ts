import type { ErrorCode } from '@nortuscc/hosted-protocol';

export class ServiceFailure extends Error {
  readonly _tag = 'ServiceFailure';
  readonly code: ErrorCode;
  readonly retryAfter: number | undefined;

  constructor(options: { readonly code: ErrorCode; readonly retryAfter?: number }) {
    super('Request failed.');
    this.code = options.code;
    this.retryAfter = options.code === 'unavailable' || options.code === 'rate_limited'
      ? Number.isSafeInteger(options.retryAfter) && options.retryAfter! > 0 ? options.retryAfter : 1
      : undefined;
  }
}
