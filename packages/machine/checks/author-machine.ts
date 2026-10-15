import { execFileSync } from 'node:child_process';
import { Effect, Layer } from 'effect';
import { nodeProcesses } from '../src/index.ts';
import { configMachine } from './config-machine.ts';
const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
export const authorMachine = () => {
  const m = configMachine();
  git(m.paths.repo, 'init', '-q'); git(m.paths.repo, 'add', '.');
  git(m.paths.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  return { ...m, git: (...args: string[]) => git(m.paths.repo, ...args), run: <A,E,R>(effect: Effect.Effect<A,E,R>) => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(m.layer(), nodeProcesses()))) as Effect.Effect<A,E>) };
};
