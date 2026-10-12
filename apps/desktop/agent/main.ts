import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startupDiagnostics, startupOperation } from './startup-diagnostics.ts';
import type { DesktopEntryInput } from './desktop-entry.ts';
export type { DesktopEntryInput } from './desktop-entry.ts';

// Record the first JS boundary before evaluating the bundled implementation and its dependencies.
export async function runDesktopEntry(input: DesktopEntryInput): Promise<number> {
  const stderr = input.stderr ?? ((line: string) => { process.stderr.write(line); });
  const trace = startupDiagnostics({ component: input.args.length === 0 ? 'agent' : 'helper',
    operation: startupOperation(input.args), write: stderr });
  trace.record('module_load', 'started');
  let implementation: typeof import('./desktop-entry.ts');
  try {
    implementation = await import('./desktop-entry.ts');
  } catch {
    trace.record('module_load', 'failed');
    try { stderr('Agent implementation could not be loaded.\n'); } catch {}
    return 1;
  }
  trace.record('module_load', 'completed');
  return implementation.runDesktopEntry(input, trace);
}

export async function readSetupChoices(stdin: AsyncIterable<string | Uint8Array>) {
  return (await import('./desktop-entry.ts')).readSetupChoices(stdin);
}

const entry = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === entry) {
  process.exitCode = await runDesktopEntry({ args: process.argv.slice(2), env: process.env, resources: dirname(entry) });
}
