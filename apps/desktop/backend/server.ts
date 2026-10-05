import { homedir } from 'node:os';
import type { Domain } from '@nortuscc/machine';
import { probeLoginPath } from './login-path.ts';
import { MAX_RECORD_BYTES, PROTOCOL_VERSION, decodeMessage, decodeRequest, type ErrorCode, type RunProgress } from './protocol.ts';
import { Session, SessionError, type DesktopServices } from './session.ts';

const MAX_NOTE_LENGTH = 4096;

// Serves protocol v2 on stdin/stdout for one session until shutdown, EOF or a signal.
export function serve(session: Session): void {
  let closing = false;
  let stdoutBroken = false;
  // Writes after the host closed stdout are dropped; the error itself triggers shutdown.
  const write = (message: unknown) => {
    if (stdoutBroken) return;
    process.stdout.write(JSON.stringify(decodeMessage(message)) + '\n');
  };
  const reject = (id: string, code: ErrorCode, message: string) =>
    write({ version: PROTOCOL_VERSION, id, ok: false, error: { code, message: message.slice(0, 500) } });
  const reply = (id: string, result: unknown) => {
    const line = JSON.stringify({ version: PROTOCOL_VERSION, id, ok: true, result });
    if (Buffer.byteLength(line) + 1 > MAX_RECORD_BYTES) return reject(id, 'OVERSIZED', `Result exceeds ${MAX_RECORD_BYTES} bytes`);
    write(JSON.parse(line));
  };
  // Domains may put captured installer output in a note; capping it keeps every event within the record limit.
  const emitRun = (runId: string, progress: RunProgress) => {
    const capped =
      progress.type === 'finished' ? { ...progress, note: progress.note.slice(0, MAX_NOTE_LENGTH) }
      : progress.type === 'failed' ? { ...progress, message: progress.message.slice(0, MAX_NOTE_LENGTH) }
      : progress;
    write({ version: PROTOCOL_VERSION, event: 'progress', runId, progress: capped });
  };
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await session.cancel();
    process.exit(0);
  };

  async function handle(raw: unknown) {
    let request;
    try {
      request = decodeRequest(raw);
    } catch {
      const id = typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 100 ? raw.id : 'invalid';
      reject(id, 'INVALID_REQUEST', 'Invalid protocol version, command or arguments');
      return;
    }
    if (closing) return reject(request.id, 'SHUTDOWN', 'Backend is shutting down');
    try {
      switch (request.command) {
        case 'inspect':
          return reply(request.id, await session.inspect());
        case 'preview':
          return reply(request.id, session.preview(request.exclude));
        case 'apply': {
          const prepared = await session.apply(request.planId);
          reply(request.id, prepared.result);
          prepared.start?.(emitRun);
          return;
        }
        case 'cancel':
          return reply(request.id, { cancelled: await session.cancel() });
        case 'shutdown':
          closing = true;
          await session.cancel();
          reply(request.id, { shutdown: true });
          process.exit(0);
      }
    } catch (err) {
      if (err instanceof SessionError) reject(request.id, err.code, err.message);
      else reject(request.id, 'INTERNAL', err instanceof Error ? err.message : String(err));
    }
  }

  let buffer = Buffer.alloc(0);
  let oversized = false;
  process.stdin.on('data', (chunk: Buffer) => {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (!oversized && buffer.length + part.length <= MAX_RECORD_BYTES) buffer = Buffer.concat([buffer, part]);
      else {
        oversized = true;
        buffer = Buffer.alloc(0);
      }
      if (newline < 0) break;
      if (oversized) reject('invalid', 'OVERSIZED', `Record exceeds ${MAX_RECORD_BYTES} bytes`);
      else {
        try {
          void handle(JSON.parse(buffer.toString('utf8'))).catch(() => reject('invalid', 'INTERNAL', 'Request failed'));
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
  process.stdout.on('error', () => {
    stdoutBroken = true;
    void shutdown();
  });
  process.stdout.on('close', () => {
    stdoutBroken = true;
    void shutdown();
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Reads the login PATH once, then serves a session over `domains` for this user's machine.
export async function startBackend(
  domains: ReadonlyArray<Domain<DesktopServices>>,
  options: { readonly tools?: ReadonlyArray<string> } = {},
): Promise<void> {
  const loginPath = await probeLoginPath({ env: process.env });
  serve(new Session({
    environment: { env: process.env, home: homedir(), platform: process.platform },
    loginPath,
    domains,
    ...(options.tools ? { tools: options.tools } : {}),
  }));
}
