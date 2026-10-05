import { Data } from 'effect';
import type { Issue } from './model.ts';

// A profile document exists but could not be read. Distinct from an absent document.
export class ReadFailed extends Data.TaggedError('ReadFailed')<{ readonly path: string; readonly reason: string }> {}

// Resolution produced issues and the caller asked for all-or-nothing.
export class ProfileInvalid extends Data.TaggedError('ProfileInvalid')<{ readonly issues: ReadonlyArray<Issue> }> {}
