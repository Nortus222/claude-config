import { Result, Schema } from 'effect';
import type { Issue, LayerName } from './model.ts';

export function issue(layer: LayerName, source: string, path: string, message: string): Issue {
  return { layer, source, path, message };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// JSON.parse with a failure recorded as an issue rather than thrown.
export function parseJson(
  text: string,
  layer: LayerName,
  source: string,
): { ok: true; value: unknown } | { ok: false; issue: Issue } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, issue: issue(layer, source, '', 'not valid JSON: check the document JSON syntax') };
  }
}

// Refuses invalid documents and unknown fields without exposing rejected values or keys.
export function decode<T>(
  schema: Schema.Codec<T, unknown>,
  value: unknown,
  layer: LayerName,
  source: string,
): { ok: true; value: T } | { ok: false; issue: Issue } {
  const result = Schema.decodeUnknownResult(schema)(value, { errors: 'all', onExcessProperty: 'error' });
  return Result.isFailure(result)
    ? { ok: false, issue: issue(layer, source, '', 'invalid document structure: check required fields, field types and unexpected keys') }
    : { ok: true, value: result.success };
}
