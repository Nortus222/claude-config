// Runs the real helper with an isolated, fake Git environment for the native timeout test.
import { join } from 'node:path';
import { runDesktopEntry } from '../../agent/main.ts';

const root = process.argv[2]!;
const home = join(root, 'home');
const env = { HOME: home, NORTUSCC_STATE_DIR: join(home, 'state'), PATH: join(root, 'tools') };
const stdin = async function* () { yield '{"configTargets":[]}'; };
process.exitCode = await runDesktopEntry({
  args: ['--bootstrap', '--app', '/inert/native/app'], resources: root, env, platform: 'linux',
  probe: async () => ({ env }), stdin: stdin(),
});
