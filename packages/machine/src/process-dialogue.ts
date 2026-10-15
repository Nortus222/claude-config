import { spawn } from 'node:child_process';
import { Context, Data, Effect, Layer } from 'effect';
import type { Command } from './processes.ts';
import { processInvocation, type Env } from './process-invocation.ts';
import { ownedProcessGroup } from './process-group.ts';

export type DialogueFailure = 'invalid-exchange' | 'launch-failed' | 'write-failed' | 'malformed-record'
  | 'record-limit' | 'output-limit' | 'stderr-limit' | 'timed-out' | 'unexpected-eof' | 'exit-failed'
  | 'unsupported-platform' | 'cleanup-failed' | 'invalid-response' | 'unsupported' | 'unexpected-request';
export class DialogueFailed extends Data.TaggedError('DialogueFailed')<{ readonly reason: DialogueFailure }> {
  override get message() { return this.reason; }
}
export class DialogueCleanupFailed extends Data.TaggedError('DialogueCleanupFailed') {
  override get message() { return 'dialogue process cleanup remains unresolved'; }
}
export type DialogueDecision = { readonly kind: 'ignore' } | { readonly kind: 'accept'; readonly value: unknown }
  | { readonly kind: 'reject'; readonly reason: DialogueFailure };
export type DialogueStep = {
  readonly send: readonly unknown[];
  // Trusted adapter correlation only. No asynchronous work or process access.
  readonly receive: (record: unknown) => DialogueDecision;
};
export type DialogueExchange = {
  readonly command: Pick<Command, 'cmd' | 'args' | 'cwd' | 'env' | 'envAllow'>;
  readonly steps: readonly DialogueStep[];
  readonly timeoutMs?: number;
  readonly maxRecordBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxStderrBytes?: number;
};
export class ProcessDialogue extends Context.Service<ProcessDialogue, {
  readonly exchange: (request: DialogueExchange) => Effect.Effect<readonly unknown[], DialogueFailed>;
}>()('machine/ProcessDialogue') {}

// One finite JSONL sequence. The layer receives the resolved login environment explicitly.
export const nodeProcessDialogue = (options: { readonly env: Env; readonly path?: string }) => Layer.succeed(ProcessDialogue, {
  exchange: request => Effect.callback<readonly unknown[], DialogueFailed>(resume => {
    // taskkill cannot establish descendant disappearance after a naturally exited leader.
    if (process.platform === 'win32') {
      resume(Effect.fail(new DialogueFailed({ reason: 'unsupported-platform' })));
      return;
    }
    const timeoutMs = request.timeoutMs ?? 10_000;
    const recordLimit = request.maxRecordBytes ?? 1024 * 1024;
    const totalLimit = request.maxTotalBytes ?? 8 * 1024 * 1024;
    const stderrLimit = request.maxStderrBytes ?? 1024 * 1024;
    let outbound: string[][];
    try {
      if ([timeoutMs, recordLimit, totalLimit, stderrLimit].some(n => !Number.isSafeInteger(n) || n <= 0)
        || request.steps.length === 0 || request.steps.length > 8) throw new Error();
      let total = 0;
      outbound = request.steps.map(step => {
        if (step.send.length === 0 || step.send.length > 8 || typeof step.receive !== 'function') throw new Error();
        return step.send.map(record => {
          const json = JSON.stringify(record);
          if (json === undefined || Buffer.byteLength(json) > recordLimit) throw new Error();
          total += Buffer.byteLength(json) + 1;
          if (total > totalLimit) throw new Error();
          return json + '\n';
        });
      });
    } catch { resume(Effect.fail(new DialogueFailed({ reason: 'invalid-exchange' }))); return; }
    const invocation = processInvocation(request.command, options.env, options.path);
    if (!invocation) { resume(Effect.fail(new DialogueFailed({ reason: 'invalid-exchange' }))); return; }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.file, invocation.args, { cwd: request.command.cwd, env: invocation.env,
        shell: false, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { resume(Effect.fail(new DialogueFailed({ reason: 'launch-failed' }))); return; }
    const group = ownedProcessGroup(child);
    let current = 0;
    const values: unknown[] = [];
    let pending = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: DialogueFailure | undefined;
    let cleanup: Promise<boolean> | undefined;
    let finished = false;
    let exitCode: number | null | undefined;
    const cleanupOnce = (graceful: boolean) => cleanup ??= (async () => {
      child.stdin?.end();
      if (graceful && await group.wait(250)) return true;
      return group.stop(1000);
    })();
    const finish = (reason?: DialogueFailure) => {
      if (reason) { failure ??= reason; pending = Buffer.alloc(0); }
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void cleanupOnce(reason === undefined).then(joined => {
        if (!joined) resume(Effect.fail(new DialogueFailed({ reason: 'cleanup-failed' })));
        else if (failure) resume(Effect.fail(new DialogueFailed({ reason: failure })));
        else if (exitCode !== undefined && exitCode !== null && exitCode !== 0) resume(Effect.fail(new DialogueFailed({ reason: 'exit-failed' })));
        else resume(Effect.succeed(values));
      });
    };
    const timer = setTimeout(() => finish('timed-out'), timeoutMs);
    const send = () => { for (const line of outbound[current]!) child.stdin?.write(line); };
    child.on('error', () => finish('launch-failed'));
    child.stdin?.on('error', () => finish('write-failed'));
    child.stderr?.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > stderrLimit) finish('stderr-limit'); });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > totalLimit) { finish('output-limit'); return; }
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline < 0) { if (pending.length > recordLimit) finish('record-limit'); return; }
        if (newline > recordLimit) { finish('record-limit'); return; }
        const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
        let record: unknown;
        try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
        catch { finish('malformed-record'); return; }
        if (finished) continue;
        let decision: DialogueDecision;
        try { decision = request.steps[current]!.receive(record); }
        catch { finish('invalid-response'); return; }
        if (decision.kind === 'reject') { finish(decision.reason); return; }
        if (decision.kind === 'accept') {
          values.push(decision.value); current++;
          if (current === request.steps.length) finish(); else send();
        }
      }
    });
    child.stdout?.once('end', () => {
      if (pending.length > 0) finish('malformed-record');
      else if (!finished) finish('unexpected-eof');
    });
    child.once('close', code => { exitCode = code; if (!finished) finish('unexpected-eof'); });
    send();
    return Effect.suspend(() => {
      finished = true; clearTimeout(timer);
      return Effect.promise(() => cleanupOnce(false)).pipe(Effect.flatMap(joined => joined
        ? Effect.void : Effect.die(new DialogueCleanupFailed())));
    });
  }),
});
