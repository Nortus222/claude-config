import { Data } from 'effect';

// Each error states itself in `message`, so a failed step's note reads as a sentence, not "".

// No usable checkout: nothing recorded, the record is stale, and the caller has no fallback.
export class RepoNotFound extends Data.TaggedError('RepoNotFound')<{ readonly recorded?: string }> {
  override get message() {
    return this.recorded === undefined
      ? 'no nortuscc checkout is recorded'
      : `the recorded checkout ${this.recorded} is not a nortuscc checkout`;
  }
}

// A filesystem operation failed for a reason other than the path being absent.
export class FsFailed extends Data.TaggedError('FsFailed')<{ readonly op: string; readonly path: string; readonly reason: string }> {
  override get message() {
    return `${this.op} ${this.path}: ${this.reason}`;
  }
}

// A child process could not be started at all.
export class LaunchFailed extends Data.TaggedError('LaunchFailed')<{ readonly cmd: string; readonly reason: string }> {
  override get message() {
    return `could not launch ${this.cmd}: ${this.reason}`;
  }
}

// Another live process holds the apply lock.
export class LockHeld extends Data.TaggedError('LockHeld')<{ readonly path: string; readonly pid: number }> {
  override get message() {
    return `another nortuscc run (pid ${this.pid}) holds ${this.path}`;
  }
}
