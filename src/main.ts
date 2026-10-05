import { LOCKED, PORTED } from '../bin/commands.mjs';
import { withApplyLock } from './lock.mjs';

type Command = { run: (args: string[]) => Promise<number> };

// Routes a verb to its TypeScript port when one exists, else to the legacy module, which holds
// the apply lock when it rewrites state.json.
export async function main([verb, ...args]: string[]): Promise<number> {
  if (PORTED.includes(verb!)) {
    const module: Command = await import(`./commands/${verb}.ts`);
    return module.run(args);
  }
  const module: Command = await import(`./commands/${verb}.mjs`);
  return LOCKED.includes(verb!) ? withApplyLock(() => module.run(args)) : module.run(args);
}
