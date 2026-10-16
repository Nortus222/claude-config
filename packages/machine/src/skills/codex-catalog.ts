import { basename, isAbsolute, normalize } from 'node:path';
import { Effect } from 'effect';
import { Fs } from '../fs.ts';
import { MachinePaths } from '../paths.ts';
import { ProcessDialogue, type DialogueDecision, type DialogueFailure } from '../process-dialogue.ts';

export type CodexUsability = { readonly verified: true; readonly path: string; readonly enabled: true }
  | { readonly verified: false; readonly reason: DialogueFailure | 'wrong-home' | 'invalid-path'
    | 'invalid-catalog' | 'discovery-errors' | 'not-found' | 'ambiguous' | 'disabled' | 'filesystem-unavailable' };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const absolutePath = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && !value.includes('\0');
const reject = (reason: DialogueFailure): DialogueDecision => ({ kind: 'reject', reason });
const response = (id: number, record: unknown): DialogueDecision => {
  if (!object(record)) return reject('invalid-response');
  if ('method' in record) {
    if (typeof record.method !== 'string') return reject('invalid-response');
    return 'id' in record ? reject('unexpected-request') : { kind: 'ignore' };
  }
  if (record.id !== id) return reject('invalid-response');
  if ('error' in record) return reject(object(record.error) && record.error.code === -32601 ? 'unsupported' : 'invalid-response');
  if (!('result' in record)) return reject('invalid-response');
  return { kind: 'accept', value: record.result };
};

// Verifies this process's effective catalog. It does not refresh an already running conversation.
export const verifyCodexSkill = (input: { readonly skillPath: string; readonly cwd: string }):
  Effect.Effect<CodexUsability, never, ProcessDialogue | Fs | MachinePaths> => Effect.gen(function* () {
    const fs = yield* Fs;
    const paths = yield* MachinePaths;
    const dialogue = yield* ProcessDialogue;
    const unavailable = (reason: Extract<CodexUsability, { verified: false }>['reason']): CodexUsability => ({ verified: false, reason });
    if (!absolutePath(input.skillPath) || basename(input.skillPath) !== 'SKILL.md' || !absolutePath(input.cwd)
      || !absolutePath(paths.codex)) return unavailable('invalid-path');
    const path = yield* fs.realPath(input.skillPath);
    const cwd = yield* fs.realPath(input.cwd);
    const home = yield* fs.realPath(paths.codex);
    if (!path || !cwd || !home || (yield* fs.stat(path))?.kind !== 'file'
      || (yield* fs.stat(cwd))?.kind !== 'directory' || (yield* fs.stat(home))?.kind !== 'directory') return unavailable('invalid-path');
    let wrongHome = false;
    const exchange = yield* dialogue.exchange({
      command: { cmd: 'codex', args: ['app-server', '--listen', 'stdio://'], cwd, env: { CODEX_HOME: home } },
      steps: [
        { send: [{ id: 1, method: 'initialize', params: { clientInfo: { name: 'nortuscc_skill_verifier', version: '0.1.0' } } }], receive: record => {
          const decision = response(1, record);
          if (decision.kind !== 'accept') return decision;
          if (!object(decision.value) || !absolutePath(decision.value.codexHome)) return reject('invalid-response');
          if (normalize(decision.value.codexHome) !== normalize(home)) { wrongHome = true; return reject('invalid-response'); }
          return decision;
        } },
        { send: [{ method: 'initialized', params: {} }, { id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } }],
          receive: record => response(2, record) },
      ],
    }).pipe(Effect.map(values => ({ ok: true as const, values })), Effect.catchTag('DialogueFailed', error =>
      Effect.succeed({ ok: false as const, reason: error.reason })));
    if (!exchange.ok) return unavailable(wrongHome && exchange.reason !== 'cleanup-failed' ? 'wrong-home' : exchange.reason);
    const catalog = exchange.values[1];
    if (!object(catalog) || !Array.isArray(catalog.data)) return unavailable('invalid-catalog');
    const rows = catalog.data.filter(row => object(row) && absolutePath(row.cwd) && normalize(row.cwd) === normalize(cwd));
    if (rows.length !== 1) return unavailable('invalid-catalog');
    const row = rows[0]!;
    if (!object(row) || !Array.isArray(row.skills) || !Array.isArray(row.errors)) return unavailable('invalid-catalog');
    // Any discovery error in the requested cwd can hide a competing or selected skill.
    if (row.errors.length !== 0) return unavailable('discovery-errors');
    const matches: Array<{ readonly path: string; readonly enabled: boolean }> = [];
    for (const skill of row.skills) {
      if (!object(skill) || !absolutePath(skill.path) || typeof skill.enabled !== 'boolean') return unavailable('invalid-catalog');
      const canonical = yield* fs.realPath(skill.path);
      if (canonical === path) matches.push({ path: canonical, enabled: skill.enabled });
    }
    if (matches.length === 0) return unavailable('not-found');
    if (matches.length > 1) return unavailable('ambiguous');
    if (!matches[0]!.enabled) return unavailable('disabled');
    return { verified: true, path, enabled: true } as const;
  }).pipe(Effect.catchTag('FsFailed', () => Effect.succeed({ verified: false, reason: 'filesystem-unavailable' } as const)));
