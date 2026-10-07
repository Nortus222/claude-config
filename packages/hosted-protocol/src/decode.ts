import { Schema } from 'effect';

export const MAX_MACHINES = 25;
export const MAX_SETUPS = 10;
export const MAX_ITEMS = 500;
export const MAX_DECISIONS = 500;
export const MAX_REVISIONS = 50;
export const MAX_CHANGELOG_BYTES = 16 * 1024;
export const MAX_REVISION_BYTES = 64 * 1024;
export const MAX_REQUEST_BODY_BYTES = 128 * 1024;

const encoder = new TextEncoder();
export const utf8ByteLength = (value: string): number => encoder.encode(value).byteLength;

// Measures the JSON representation sent on the wire, including escaping and field names.
export const jsonByteLength = (value: unknown): number => {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error();
    return utf8ByteLength(json);
  } catch {
    throw new Error('Invalid hosted payload');
  }
};

// Strict decoding applies to every nested schema. Rejections never expose input or causes.
export const decodeHosted = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S['Type'] => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(value);
  } catch {
    throw new Error('Invalid hosted payload');
  }
};

export const decodeRequestBody = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S['Type'] => {
  if (jsonByteLength(value) > MAX_REQUEST_BODY_BYTES) throw new Error('Hosted request body too large');
  return decodeHosted(schema, value);
};
