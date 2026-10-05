import { PORTED } from '../bin/commands.mjs';

type Command = { run: (args: string[]) => Promise<number> };

// Routes a verb to its TypeScript port when one exists, else to the legacy module.
export async function main([verb, ...args]: string[]): Promise<number> {
  const module: Command = PORTED.includes(verb!)
    ? await import(`./commands/${verb}.ts`)
    : await import(`./commands/${verb}.mjs`);
  return module.run(args);
}
