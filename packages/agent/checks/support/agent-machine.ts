import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { configDomain, HistoryStore, integrationsDomain, type MachinePathsValue } from '@nortuscc/machine';
import { agentLayer, SetupSource, SetupsStore, type AgentDomain, type AgentServices } from '../../src/index.ts';

const NO_SOURCE = () => Effect.die(new Error('this test has no setup source'));

// For tests that never refresh or resolve.
const noSource = Layer.succeed(SetupSource, { fetch: NO_SOURCE(), load: NO_SOURCE, effective: NO_SOURCE });

// A temporary HOME, git checkout and state root, with the agent's services over them.
export const agentMachine = () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-'));
  const home = join(root, 'home');
  const stateRoot = join(home, '.config', 'nortuscc');
  const paths: MachinePathsValue = {
    repo: join(root, 'checkout'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot, backups: join(stateRoot, 'backups'),
  };
  // The checkout is a git repo with an origin, as a real one is, so trusting it runs git cleanly.
  mkdirSync(paths.repo, { recursive: true });
  spawnSync('git', ['init', '-q', paths.repo]);
  spawnSync('git', ['-C', paths.repo, 'remote', 'add', 'origin', 'https://github.com/example/setup.git']);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
  const domains: ReadonlyArray<AgentDomain> = [configDomain, integrationsDomain({ paths, env: {} })];
  const run = <A, E>(effect: Effect.Effect<A, E, AgentServices | SetupSource>, source: Layer.Layer<SetupSource> = noSource) =>
    Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(agentLayer(paths), source))));
  const events = () => run(HistoryStore.use((h) => h.read));
  const kinds = async () => (await events()).map((e) => e.kind);
  const agentJson = () => JSON.parse(read(join(stateRoot, 'agent', 'agent.json')) ?? '{}');
  // Trusts the own checkout without running git.
  const trust = () => run(SetupsStore.use((s) => s.write([{ setupId: null, repoUrl: null, checkout: paths.repo, trustedAt: '2026-10-06T00:00:00.000Z' }])));
  return { root, paths, write, read, domains, run, events, kinds, agentJson, trust };
};
