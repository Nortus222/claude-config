type Command = { run: (args: string[]) => Promise<number> };

// Routes a verb to src/commands/<verb>.ts. A command that writes state takes the apply lock
// itself, through @nortuscc/machine's executor.
export async function main([verb, ...args]: string[]): Promise<number> {
  const module: Command = await import(`./commands/${verb}.ts`);
  return module.run(args);
}
