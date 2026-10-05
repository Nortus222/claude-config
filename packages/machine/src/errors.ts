import { Data } from 'effect';

// No usable checkout: nothing recorded, the record is stale, and the caller has no fallback.
export class RepoNotFound extends Data.TaggedError('RepoNotFound')<{ readonly recorded?: string }> {}

// A filesystem operation failed for a reason other than the path being absent.
export class FsFailed extends Data.TaggedError('FsFailed')<{ readonly op: string; readonly path: string; readonly reason: string }> {}

// A child process could not be started at all.
export class LaunchFailed extends Data.TaggedError('LaunchFailed')<{ readonly cmd: string; readonly reason: string }> {}

// Another live process holds the apply lock.
export class LockHeld extends Data.TaggedError('LockHeld')<{ readonly path: string; readonly pid: number }> {}
