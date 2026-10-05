import { Effect, Exit } from 'effect';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  decodeRequest,
  decodeMessage,
  MAX_RECORD_BYTES,
  type Progress,
  type Response,
} from './protocol.ts';
import { desiredFixture, inspectFixture, type Value } from './fixture.ts';
import { fixtureOperation } from './operation.ts';

// The child's pipe lifetime also cleans resources if the backend is killed abruptly.
if (process.argv.includes('--fixture-child')) {
  const directory = process.argv.at(-1)!;
  let closing = false;
  const finish = async () => {
    if (closing) return;
    closing = true;
    await rm(directory, { recursive: true, force: true });
    process.exit(0);
  };
  process.stdin.resume();
  process.stdin.on('end', finish);
  process.on('SIGTERM', finish);
} else {
  let current: Record<string, Value> | undefined;
  let active: { id: string; abort: AbortController; done: Promise<void> } | undefined;
  let closing = false;
  const emit = (message: Progress | Response) => {
    const decoded = decodeMessage(message);
    process.stdout.write(JSON.stringify(decoded) + '\n');
  };
  const reply = (id: string, result: unknown) => emit({ version: 1, id, ok: true, result });
  const reject = (id: string, code: string, message: string) =>
    emit({ version: 1, id, ok: false, error: { code, message } });
  const stop = async () => {
    const operation = active;
    operation?.abort.abort();
    await operation?.done;
  };
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await stop();
    process.exit(0);
  };
  async function handle(raw: unknown) {
    let request;
    try {
      request = decodeRequest(raw);
    } catch {
      const id =
        typeof raw === 'object' &&
        raw !== null &&
        'id' in raw &&
        typeof raw.id === 'string' &&
        raw.id.length > 0 &&
        raw.id.length <= 100
          ? raw.id
          : 'invalid';
      reject(id, 'INVALID_REQUEST', 'Invalid protocol version, command or arguments');
      return;
    }
    if (closing) {
      reject(request.id, 'SHUTDOWN', 'Backend is shutting down');
      return;
    }
    switch (request.command) {
      case 'inspect':
        reply(request.id, inspectFixture(current));
        break;
      case 'start': {
        if (active) {
          reject(request.id, 'BUSY', 'A fixture operation is already running');
          break;
        }
        const id = randomUUID(),
          abort = new AbortController();
        // Acknowledgement precedes all events; the operation remains busy until cleanup finishes.
        reply(request.id, { operationId: id });
        const operation = { id, abort, done: Promise.resolve() };
        active = operation;
        emit({
          version: 1,
          event: 'progress',
          operationId: id,
          state: 'running',
          percent: 0,
          detail: 'Preparing a temporary fixture',
        });
        operation.done = Effect.runPromiseExit(fixtureOperation(id, emit), {
          signal: abort.signal,
        }).then((exit) => {
          const state = abort.signal.aborted
            ? 'cancelled'
            : Exit.isSuccess(exit)
              ? 'completed'
              : 'failed';
          if (state === 'completed') current = desiredFixture();
          active = undefined;
          emit({
            version: 1,
            event: 'progress',
            operationId: id,
            state,
            percent: state === 'completed' ? 100 : 0,
            detail:
              state === 'completed'
                ? 'Fixture applied and temporary resources removed'
                : state === 'cancelled'
                  ? 'Cancelled; temporary resources removed'
                  : 'Fixture failed; temporary resources removed',
          });
        });
        break;
      }
      case 'cancel':
        await stop();
        reply(request.id, { cancelled: true });
        break;
      case 'shutdown':
        closing = true;
        await stop();
        reply(request.id, { shutdown: true });
        process.exit(0);
        break;
      case 'crash':
        closing = true;
        await stop();
        reply(request.id, { crash: true });
        process.exit(86);
        break;
    }
  }
  let buffer = Buffer.alloc(0),
    oversized = false;
  process.stdin.on('data', (chunk: Buffer) => {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (!oversized && buffer.length + part.length <= MAX_RECORD_BYTES)
        buffer = Buffer.concat([buffer, part]);
      else {
        oversized = true;
        buffer = Buffer.alloc(0);
      }
      if (newline < 0) break;
      if (oversized) reject('invalid', 'OVERSIZED', 'Record exceeds 16384 bytes');
      else {
        try {
          void handle(JSON.parse(buffer.toString('utf8'))).catch(() =>
            reject('invalid', 'INTERNAL', 'Request failed'),
          );
        } catch {
          reject('invalid', 'MALFORMED', 'Expected a JSON record');
        }
      }
      buffer = Buffer.alloc(0);
      oversized = false;
      offset = newline + 1;
    }
  });
  process.stdin.on('end', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
