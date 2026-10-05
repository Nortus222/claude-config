// Measures backend startup (spawn to first inspect reply) and idle memory for a runtime command.
// Usage: node scripts/measure.mjs <executable> [args...]
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: node scripts/measure.mjs <executable> [args...]');
const runs = 10;
const idleMs = 2000;
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const startups = [];
const rss = [];
for (let run = 0; run < runs; run++) {
  const session = await mkdtemp(join(tmpdir(), 'nortuscc-measure-'));
  const started = performance.now();
  const child = spawn(command, args, {
    cwd: session,
    env: { PATH: '', NORTUSCC_FIXTURE_SESSION: session },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(JSON.stringify({ version: 1, id: '1', command: 'inspect' }) + '\n');
  const [line] = await once(lines, 'line');
  startups.push(performance.now() - started);
  if (!JSON.parse(line).ok) throw new Error(`Inspect failed: ${line}`);
  await new Promise((resolve) => setTimeout(resolve, idleMs));
  const kib = execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], {
    encoding: 'utf8',
  });
  rss.push(Number(kib));
  const exited = once(child, 'exit');
  child.stdin.end();
  await exited;
  await rm(session, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    runs,
    startupMs: Math.round(median(startups)),
    idleRssMiB: Math.round(median(rss) / 1024),
  }),
);
