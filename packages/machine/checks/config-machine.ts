import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Effect, Layer, Stream } from 'effect';
import { loadProfile, nodeFiles, type Input, type MachineOverrides } from '@nortuscc/profile-engine';
import {
  backupsForRun, configDomain, execute, inspect, machinePaths, nodeFs, plan, selectAll, stateStore,
  type MachinePathsValue, type MachineReport, type Plan, type PlanKind, type Selection,
} from '../src/index.ts';
import { inspectConfig } from '../src/config/inspect.ts';

export const REPO_FILES: Readonly<Record<string, string>> = {
  'claude/CLAUDE.md': '# repo claude\n',
  'codex/AGENTS.md': '# repo codex\n',
  'codex/openrouter-glm/models-static.json': '{"models":[]}\n',
  'codex/openrouter-glm/config.toml': 'model = "glm"\n',
  'claude/settings.keys.json': JSON.stringify({ theme: 'dark', model: 'opus' }, null, 2) + '\n',
};

// A temporary repo checkout and agent homes, with the services a config run needs.
export const configMachine = (repoFiles: Readonly<Record<string, string>> = REPO_FILES) => {
  const root = mkdtempSync(join(tmpdir(), 'machine-config-'));
  const paths: MachinePathsValue = {
    repo: join(root, 'repo'), claude: join(root, '.claude'), codex: join(root, '.codex'),
    codexOpenRouter: join(root, '.codex-openrouter'), agentsSkills: join(root, 'skills'),
    stateRoot: join(root, 'state'), backups: join(root, 'state', 'backups'),
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
  for (const [relative, text] of Object.entries(repoFiles)) write(join(paths.repo, relative), text);

  let runs = 0;
  // A fresh backups layer per run, each with its own stamp, as a command builds one per run.
  const layer = () => Layer.mergeAll(stateStore, backupsForRun(new Date(Date.UTC(2026, 9, 5, 12, 0, runs++))))
    .pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const desired = (overrides?: Input<MachineOverrides>) =>
    Effect.runPromise(loadProfile(paths.repo, { overrides }).pipe(Effect.provide(nodeFiles)));
  const observe = async (overrides?: Input<MachineOverrides>) =>
    Effect.runPromise(inspectConfig(await desired(overrides)).pipe(Effect.provide(layer())));
  const state = (): { files: Record<string, { hash: string }>; skillsOnly?: boolean } =>
    JSON.parse(read(join(paths.stateRoot, 'state.json')) ?? '{"files":{}}');
  const baselines = (files: Record<string, string>) =>
    write(join(paths.stateRoot, 'state.json'), JSON.stringify({
      version: 1, repo: null, skillsOnly: false,
      files: Object.fromEntries(Object.entries(files).map(([key, hash]) => [key, { hash, appliedAt: '2026-10-05T00:00:00.000Z' }])),
    }));
  const report = async (overrides?: Input<MachineOverrides>) =>
    Effect.runPromise(inspect(await desired(overrides), [configDomain]).pipe(Effect.provide(layer())));
  const planFor = (r: MachineReport, kind: PlanKind = 'apply', selection: Partial<Selection> = {}) =>
    plan(kind, r, { ...selectAll, ...selection }, [configDomain]);
  const executePlan = (p: Plan, r: MachineReport) =>
    Effect.runPromise(Stream.runCollect(execute(p, r, [configDomain])).pipe(Effect.map((c) => [...c]), Effect.provide(layer())));
  // Inspect, plan and execute in one go, as a command does.
  const sync = async (kind: PlanKind = 'apply', selection: Partial<Selection> = {}) => {
    const r = await report();
    const p = planFor(r, kind, selection);
    const events = await executePlan(p, r);
    const notes = Object.fromEntries(events.flatMap((e) => (e.type === 'finished' ? [[e.key, `${e.outcome}: ${e.note}`]] : [])));
    return { report: r, plan: p, events, notes };
  };
  return { root, paths, write, read, desired, layer, observe, state, baselines, report, plan: planFor, execute: executePlan, sync };
};
