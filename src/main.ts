import { remindAfter } from './reminder.ts';

type Command = { run: (args: string[]) => Promise<number> };

// Routes a verb to src/commands/<verb>.ts. A command that writes state takes the apply lock
// itself, through @nortuscc/machine's executor. On a terminal, an interactive verb is followed by a
// reminder about items waiting on the agent; it never changes the exit code.
export async function main([verb, ...args]: string[]): Promise<number> {
  const module: Command = await import(`./commands/${verb}.ts`);
  const code = await module.run(args);
  await remindAfter(verb);
  return code;
}
