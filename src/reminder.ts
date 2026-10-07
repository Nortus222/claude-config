import { Effect } from 'effect';
import type { MachinePathsValue } from '@nortuscc/machine';
import type { WireStatus } from '@nortuscc/agent';
import { connectAgent, type AgentConnection } from './agent-client.ts';
import { resolvePaths } from './machine.ts';

export const REMINDER_BUDGET_MS = 300;

type Options = {
  connect?: (paths: MachinePathsValue, options: { timeoutMs: number }) => Promise<AgentConnection>;
  budgetMs?: number;
  write?: (line: string) => void;
};

// Asks a reachable agent for its status and writes one line when items wait for a person. The whole
// ask shares `budgetMs`. Never throws and writes nothing on any failure or timeout.
export async function reminder(paths: MachinePathsValue, options: Options = {}): Promise<void> {
  const { connect = connectAgent, budgetMs = REMINDER_BUDGET_MS, write = (line) => console.error(line) } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connection: AgentConnection | undefined;
  let expired = false;
  const ask = async (): Promise<number> => {
    const conn = await connect(paths, { timeoutMs: budgetMs });
    connection = conn;
    if (expired) conn.close();
    const status = await conn.request<WireStatus>({ command: 'status' }, { timeoutMs: budgetMs });
    return status.counts.held + status.counts.ready;  // pending also holds held and auto-applied items
  };
  try {
    const waiting = await Promise.race([
      ask(),
      new Promise<number>((resolve) => { timer = setTimeout(() => { expired = true; resolve(0); }, budgetMs); }),
    ]);
    if (waiting > 0) write(`${waiting} ${waiting === 1 ? 'item waits' : 'items wait'} for you: run nortuscc agent review`);
  } catch {
    // A reminder is a courtesy; any failure is silence.
  } finally {
    clearTimeout(timer);
    try { connection?.close(); } catch {}
  }
}

// Only read-only verbs. A verb that writes runs in this process, so the agent cannot know it just
// changed the machine; its last status could still list items that verb applied.
const REMINDED = new Set(['status']);

// After a reminded verb on a terminal, reminds about waiting items. Never throws, and never
// resolves paths loudly.
export async function remindAfter(verb: string | undefined, options: Options & { interactive?: boolean; paths?: () => Promise<MachinePathsValue> } = {}): Promise<void> {
  try {
    const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
    if (!interactive || verb === undefined || !REMINDED.has(verb)) return;
    const paths = await (options.paths ?? (() => Effect.runPromise(resolvePaths(() => {}))))();
    await reminder(paths, options);
  } catch {}
}
