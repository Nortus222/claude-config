import { basename, isAbsolute, normalize } from 'node:path';
import { Effect } from 'effect';
import { Fs } from '../fs.ts';
import { MachinePaths } from '../paths.ts';
import { ProcessDialogue, type DialogueDecision, type DialogueFailure } from '../process-dialogue.ts';

export type ClaudeRestrictionDiagnostic = 'effective-skill-denial' | 'approval-required' | 'unsupported-rule-matching'
  | 'unsupported-rule-source' | 'settings-errors' | 'unsupported-permissions';
export type ClaudeRestrictionEvidence = {
  readonly status: 'no-known-denial' | 'denied' | 'unknown' | 'unavailable';
  readonly managedOnly?: boolean;
  readonly diagnostics: readonly ClaudeRestrictionDiagnostic[];
};
export type ClaudeVerificationFailure = DialogueFailure | 'invalid-path' | 'invalid-selector' | 'invalid-catalog'
  | 'not-found' | 'ambiguous' | 'denied' | 'unknown-restrictions' | 'settings-errors'
  | 'unsupported-permissions' | 'filesystem-unavailable';
export type ClaudeSkillEvidence = {
  readonly verified: boolean;
  readonly reason?: ClaudeVerificationFailure;
  // Physical path evidence is separate from accepted-content integrity, owned by the installer.
  readonly physical: { readonly status: 'present'; readonly path: string } | { readonly status: 'unavailable' };
  readonly catalog: { readonly status: 'present' | 'missing' | 'ambiguous' | 'unavailable'; readonly userCommand?: boolean };
  readonly restrictions: ClaudeRestrictionEvidence;
  readonly limits: {
    readonly selectedSource: 'not-attested';
    readonly invocationAuthorization: 'not-attested';
    readonly configRoot: 'requested-environment-only';
    readonly managedStartup: 'remains-active';
  };
};
const limits: ClaudeSkillEvidence['limits'] = { selectedSource: 'not-attested', invocationAuthorization: 'not-attested',
  configRoot: 'requested-environment-only', managedStartup: 'remains-active' };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const absolute = (value: string) => isAbsolute(value) && !value.includes('\0');
const label = (value: string) => value.length > 0 && value.length <= 255 && !/[\u0000-\u001f\u007f]/.test(value);
const reject = (reason: DialogueFailure): DialogueDecision => ({ kind: 'reject', reason });

// Versioned vendor control envelope. No host request is answered or dispatched.
const response = (id: string, record: unknown): DialogueDecision => {
  if (!object(record) || typeof record.type !== 'string') return reject('invalid-response');
  if (record.type === 'control_request') return reject('unexpected-request');
  if (record.type === 'control_cancel_request') return reject('invalid-response');
  if (record.type !== 'control_response') return { kind: 'ignore' };
  const reply = record.response;
  if (!object(reply) || reply.request_id !== id) return reject('invalid-response');
  // No error-message matching or exposure. An error cannot prove protocol support.
  if (reply.subtype === 'error') return reject('unsupported');
  if (reply.subtype !== 'success' || !object(reply.response)) return reject('invalid-response');
  for (const field of ['pending_permission_requests', 'pending_user_dialog_requests']) {
    if (field in reply && (!Array.isArray(reply[field]) || reply[field].length !== 0)) return reject('unexpected-request');
  }
  return { kind: 'accept', value: reply.response };
};
type CommandRow = { readonly name: string; readonly aliases: readonly string[]; readonly builtin: boolean };
const catalogRows = (payload: unknown, field: string): readonly CommandRow[] | undefined => {
  if (!object(payload) || !Array.isArray(payload[field])) return undefined;
  const rows: CommandRow[] = [];
  for (const row of payload[field]) {
    if (!object(row) || typeof row.name !== 'string' || !label(row.name)
      || typeof row.description !== 'string' || typeof row.argumentHint !== 'string'
      || ('builtin' in row && typeof row.builtin !== 'boolean')
      || ('aliases' in row && (!Array.isArray(row.aliases) || row.aliases.some(alias => typeof alias !== 'string' || !label(alias))))) return undefined;
    rows.push({ name: row.name, aliases: (row.aliases ?? []) as string[], builtin: row.builtin === true });
  }
  return rows;
};
const ruleSources = new Set(['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings',
  'cliArg', 'command', 'session', 'toolsNarrowing', 'mcpServerPolicy', 'hostCredential']);

// Only exact Skill identities and blanket denials are interpreted. Native authorization stays unknown.
const restrictionEvidence = (payload: unknown, names: ReadonlySet<string>, cwd: string): ClaudeRestrictionEvidence => {
  const unsupported: ClaudeRestrictionEvidence = { status: 'unavailable', diagnostics: ['unsupported-permissions'] };
  if (!object(payload) || !object(payload.state)) return unsupported;
  const state = payload.state;
  if (!Array.isArray(state.rules) || !Array.isArray(state.workspaceDirectories) || typeof state.originalCwd !== 'string'
    || !absolute(state.originalCwd) || normalize(state.originalCwd) !== normalize(cwd) || typeof state.managedOnly !== 'boolean'
    || ('errors' in state && !Array.isArray(state.errors))) return unsupported;
  const diagnostics = new Set<ClaudeRestrictionDiagnostic>();
  if (Array.isArray(state.errors) && state.errors.length > 0) diagnostics.add('settings-errors');
  for (const entry of state.rules) {
    if (!object(entry) || typeof entry.behavior !== 'string' || !['allow', 'deny', 'ask'].includes(entry.behavior) || typeof entry.rule !== 'string'
      || typeof entry.source !== 'string' || typeof entry.editability !== 'string' || !['persistent', 'session', 'readonly'].includes(entry.editability)
      || ('notInEffect' in entry && typeof entry.notInEffect !== 'boolean')) return unsupported;
    if (entry.notInEffect === true) continue;
    if (!ruleSources.has(entry.source)) diagnostics.add('unsupported-rule-source');
    if (entry.behavior === 'allow') continue;
    const exact = /^Skill\(([^()]+)\)$/.exec(entry.rule);
    const matches = entry.rule === 'Skill' || entry.rule === 'Skill(*)' || !!exact && names.has(exact[1]!);
    if (matches) diagnostics.add(entry.behavior === 'deny' ? 'effective-skill-denial' : 'approval-required');
    else if (exact && !/[\s*?:\\\[\]\u0000-\u001f\u007f]/.test(exact[1]!)) continue;
    else if (!/^[A-Za-z][A-Za-z0-9_]*(?:\([^]*\))?$/.test(entry.rule) || /^skill/i.test(entry.rule)) diagnostics.add('unsupported-rule-matching');
  }
  return { status: diagnostics.has('effective-skill-denial') ? 'denied' : diagnostics.size ? 'unknown' : 'no-known-denial',
    managedOnly: state.managedOnly, diagnostics: [...diagnostics] };
};

// Requires an accepted install and a trusted existing neutral temporary cwd. HOME comes from the entry layer.
export const verifyClaudeSkill = (input: {
  readonly skillPath: string; readonly selectorName: string; readonly installedName: string; readonly cwd: string;
}): Effect.Effect<ClaudeSkillEvidence, never, ProcessDialogue | Fs | MachinePaths> => Effect.gen(function* () {
  const fs = yield* Fs; const paths = yield* MachinePaths; const dialogue = yield* ProcessDialogue;
  let physical: ClaudeSkillEvidence['physical'] = { status: 'unavailable' };
  let catalog: ClaudeSkillEvidence['catalog'] = { status: 'unavailable' };
  let restrictions: ClaudeRestrictionEvidence = { status: 'unavailable', diagnostics: [] };
  const result = (reason?: ClaudeVerificationFailure): ClaudeSkillEvidence => ({ verified: reason === undefined,
    ...(reason ? { reason } : {}), physical, catalog, restrictions, limits });
  if (!absolute(input.skillPath) || basename(input.skillPath) !== 'SKILL.md' || !absolute(input.cwd) || !absolute(paths.claude)) return result('invalid-path');
  if (!label(input.selectorName) || !label(input.installedName)) return result('invalid-selector');
  return yield* Effect.gen(function* () {
    const path = yield* fs.realPath(input.skillPath); const cwd = yield* fs.realPath(input.cwd); const configRoot = yield* fs.realPath(paths.claude);
    if (!path || !cwd || !configRoot || (yield* fs.stat(path))?.kind !== 'file'
      || (yield* fs.stat(cwd))?.kind !== 'directory' || (yield* fs.stat(configRoot))?.kind !== 'directory') return result('invalid-path');
    physical = { status: 'present', path };
    const names = new Set([input.selectorName, input.installedName]);
    let userRows: readonly CommandRow[] | undefined;
    let modelRows: readonly CommandRow[] | undefined;
    const projectCatalog = () => {
      if (!userRows || !modelRows) return;
      const matching = (row: CommandRow) => names.has(row.name) || row.aliases.some(alias => names.has(alias));
      const modelMatches = modelRows.filter(matching); const userMatches = userRows.filter(matching);
      const identity = (row: CommandRow) => JSON.stringify([row.name, row.builtin, [...new Set(row.aliases)].sort()]);
      const competing = [...modelMatches, ...userMatches].some(row => row.builtin)
        || modelMatches.length === 1 && userMatches.length === 1 && identity(modelMatches[0]!) !== identity(userMatches[0]!);
      // Aliases cannot disambiguate native rows that compete for either accepted identity.
      catalog = { status: modelMatches.length === 0 ? 'missing' : competing || modelMatches.length > 1 || userMatches.length > 1 ? 'ambiguous' : 'present',
        userCommand: userMatches.length > 0 };
      for (const row of [...modelMatches, ...userMatches]) { names.add(row.name); for (const alias of row.aliases) names.add(alias); }
    };
    const values = yield* dialogue.exchange({ command: { cmd: 'claude', cwd, env: { CLAUDE_CONFIG_DIR: configRoot },
      args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}'] },
      steps: ['initialize', 'reload_skills', 'list_permission_rules'].map((subtype, index) => {
        const id = `nortuscc-${index + 1}`;
        return { send: [{ type: 'control_request', request_id: id, request: { subtype } }], receive: (record: unknown) => {
          const decision = response(id, record);
          if (decision.kind === 'accept') {
            if (index === 0) userRows = catalogRows(decision.value, 'commands');
            if (index === 1) { modelRows = catalogRows(decision.value, 'skills'); projectCatalog(); }
            if (index === 2) restrictions = restrictionEvidence(decision.value, names, cwd);
          }
          return decision;
        } };
      }),
    });
    if (values.length !== 3 || !userRows || !modelRows) return result('invalid-catalog');
    if (catalog.status === 'missing') return result('not-found');
    if (catalog.status === 'ambiguous') return result('ambiguous');
    if (restrictions.status === 'unavailable') return result('unsupported-permissions');
    if (restrictions.status === 'denied') return result('denied');
    if (restrictions.diagnostics.includes('settings-errors')) return result('settings-errors');
    if (restrictions.status === 'unknown') return result('unknown-restrictions');
    return result();
  }).pipe(Effect.catchTag('DialogueFailed', error => Effect.succeed(result(error.reason))),
    Effect.catchTag('FsFailed', () => Effect.succeed(result('filesystem-unavailable'))));
});
