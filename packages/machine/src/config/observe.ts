import { join } from 'node:path';
import { Effect } from 'effect';
import type { DesiredConfig, FileEntry, Origin, ResolvedFile } from '@nortuscc/profile-engine';
import { Fs } from '../fs.ts';
import { hashText } from '../hash.ts';
import { homeDir, MachinePaths, type MachinePathsValue } from '../paths.ts';
import type { Baseline } from '../state.ts';
import { fileState, hashValue } from './file-state.ts';
import { splitProjectTrust } from './project-trust.ts';

// What `steps` needs beyond `state`. recorded: nortuscc holds a baseline. local-changed: the machine
// side differs from it (uninstall's "changed since apply"). local-absent: nothing on the machine
// side. baseline-stale: both sides agree, but on content newer than the baseline.
export type Fact = 'recorded' | 'local-changed' | 'local-absent' | 'baseline-stale';

// One copied file or settings key as it stands now.
export type Reading = {
  readonly key: string;
  readonly label: string;
  readonly state: string;
  readonly facts: ReadonlyArray<Fact>;
  readonly from: Origin;
  readonly note?: string;
};
export type CopyReading = Reading & { readonly repoText?: string; readonly localText?: string };
export type Document =
  | { readonly kind: 'absent' }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'object'; readonly value: Readonly<Record<string, unknown>> };
export type DocumentReading = { readonly readings: ReadonlyArray<Reading>; readonly local: Document; readonly repoText?: string };

export const itemKey = (fileId: string, settingsKey?: string): string =>
  settingsKey === undefined ? `config:${fileId}` : `config:${fileId}#${settingsKey}`;

// The managed file an item or step key belongs to. File ids never contain '#'.
export const configFileId = (key: string): string => key.slice('config:'.length).split('#')[0]!;

export const settingsKeyOf = (key: string): string | undefined => {
  const at = key.indexOf('#');
  return at === -1 ? undefined : key.slice(at + 1);
};

export const filePaths = (paths: MachinePathsValue, file: Pick<FileEntry, 'home' | 'src' | 'dest'>) => ({
  src: join(paths.repo, file.src),
  dest: join(homeDir(paths, file.home), file.dest),
});

// What a copied file's hash covers: its whole text, or with preserveProjects only the managed part.
export const contentHash = (file: Pick<FileEntry, 'preserveProjects'>, text: string | undefined): string | undefined =>
  text === undefined ? undefined : hashText(file.preserveProjects ? splitProjectTrust(text).managed : text);

// Absent and unparseable differ: a missing settings file is ordinary, a broken one is the user's to fix.
export const parseDocument = (text: string | undefined): Document => {
  if (text === undefined) return { kind: 'absent' };
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'corrupt' };
    return { kind: 'object', value: value as Record<string, unknown> };
  } catch {
    return { kind: 'corrupt' };
  }
};

const factsFor = (baseline: string | undefined, repo: string | undefined, local: string | undefined, state: string): Fact[] => [
  ...(baseline !== undefined ? ['recorded' as const] : []),
  ...(baseline !== undefined && local !== baseline ? ['local-changed' as const] : []),
  ...(local === undefined ? ['local-absent' as const] : []),
  ...(state === 'clean' && baseline !== repo ? ['baseline-stale' as const] : []),
];

export const readCopy = (file: ResolvedFile, baselines: Readonly<Record<string, Baseline>>) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const { src, dest } = filePaths(yield* MachinePaths, file);
    const repoText = yield* fs.readText(src);
    const localText = yield* fs.readText(dest);
    const baseline = baselines[file.id]?.hash;
    const repo = contentHash(file, repoText);
    const local = contentHash(file, localText);
    const state = fileState({ baseline, repo, local });
    const reading: CopyReading = {
      key: itemKey(file.id), label: file.dest, state, facts: factsFor(baseline, repo, local, state), from: file.from, repoText, localText,
    };
    return reading;
  });

// One reading per owned key, or a single document reading when the repo side owns nothing
// (absent or refused) or the machine side will not parse.
export const readMerge = (file: ResolvedFile, desired: DesiredConfig, baselines: Readonly<Record<string, Baseline>>) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const { src, dest } = filePaths(yield* MachinePaths, file);
    const repoText = yield* fs.readText(src);
    const local = parseDocument(yield* fs.readText(dest));
    const localValue = (key: string) => (local.kind === 'object' && Object.hasOwn(local.value, key) ? local.value[key] : undefined);
    const recorded = Object.keys(baselines).filter((k) => k.startsWith(`${file.id}#`));
    const changed = local.kind === 'corrupt'
      || recorded.some((k) => hashValue(localValue(k.slice(file.id.length + 1))) !== baselines[k]!.hash);
    const documentFacts: Fact[] = [
      ...(recorded.length ? ['recorded' as const] : []),
      ...(recorded.length && changed ? ['local-changed' as const] : []),
      ...(local.kind === 'absent' ? ['local-absent' as const] : []),
    ];
    const whole = (state: string, note?: string): DocumentReading => ({
      readings: [{ key: itemKey(file.id), label: file.dest, state, facts: documentFacts, from: file.from, ...(note ? { note } : {}) }],
      local,
      repoText,
    });

    const keys = file.keys ?? {};
    if (Object.keys(keys).length === 0) {
      const issues = desired.issues.filter((i) => i.layer === 'base' && i.source === file.src);
      return issues.length ? whole('invalid', issues.map((i) => i.message).join('; ')) : whole('missing-repo');
    }
    if (local.kind === 'corrupt') return whole('unparseable-local');

    const readings = Object.entries(keys).map(([key, { value, from }]): Reading => {
      const baseline = baselines[`${file.id}#${key}`]?.hash;
      const repo = hashValue(value);
      const localHash = hashValue(localValue(key));
      const state = fileState({ baseline, repo, local: localHash });
      return { key: itemKey(file.id, key), label: `${file.dest}#${key}`, state, facts: factsFor(baseline, repo, localHash, state), from };
    });
    const reading: DocumentReading = { readings, local, repoText };
    return reading;
  });
