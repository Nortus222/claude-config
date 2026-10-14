import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { overridesFromLegacyState } from '@nortuscc/profile-engine';
import type { FsFailed } from './errors.ts';
import { Fs } from './fs.ts';
import { MachinePaths } from './paths.ts';

export type Baseline = { readonly hash: string; readonly appliedAt: string };
// The setup commit this machine last applied in full, recorded by `nortuscc sync` (#43).
export type Applied = { readonly commit: string; readonly at: string };
export const MCP_ROUTING_BLOCK_ID = 'nortuscc-mcp-routing-v1' as const;
export const MCP_ROUTING_BEGIN = '<!-- nortuscc:mcp-routing:v1:begin -->';
export const MCP_ROUTING_END = '<!-- nortuscc:mcp-routing:v1:end -->';
export const MCP_ROUTING_GUIDANCE = 'For nortuscc configuration, skills, plugins, and MCP connections, use the nortuscc MCP tools. Inspect before making changes and preview before applying them. Changes default to this machine; publish to a personal or shared profile only when explicitly requested.';
export const MCP_ROUTING_TEXT = `${MCP_ROUTING_BEGIN}\n${MCP_ROUTING_GUIDANCE}\n${MCP_ROUTING_END}`;
// Separators belong to the receipt too; removing it never normalizes neighboring prose.
export const MCP_ROUTING_BYTES = `\n\n${MCP_ROUTING_TEXT}\n`;
export type McpRoutingFileId = 'claude:CLAUDE.md' | 'codex:AGENTS.md';
export type McpRoutingReceipt = {
  readonly fileId: McpRoutingFileId;
  readonly blockId: typeof MCP_ROUTING_BLOCK_ID;
  readonly bytes: typeof MCP_ROUTING_BYTES;
  readonly state: 'active' | 'released';
};
export type McpRoutingOwnership = {
  readonly version: 1;
  readonly files: Readonly<Partial<Record<McpRoutingFileId, McpRoutingReceipt>>>;
};

export type MachineState = {
  readonly version: 1;
  readonly repo: string | null;
  readonly files: Readonly<Record<string, Baseline>>;
  readonly applied?: Applied;
  // Untrusted JSON is retained on writes so malformed ownership cannot become permission to overwrite.
  readonly mcpRouting?: unknown;
};

export const emptyState: MachineState = { version: 1, repo: null, files: {} };

// The one legacy key worth carrying forward from the pre-Codex lock.
const LEGACY_KEYS: Record<string, string> = { 'CLAUDE.md': 'claude:CLAUDE.md' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isMcpRoutingFileId = (value: string): value is McpRoutingFileId =>
  value === 'claude:CLAUDE.md' || value === 'codex:AGENTS.md';

export const validMcpRouting = (value: unknown): value is McpRoutingOwnership =>
  isRecord(value) && value.version === 1 && Object.keys(value).length === 2 && isRecord(value.files)
  && Object.entries(value.files).every(([id, receipt]) => isMcpRoutingFileId(id) && isRecord(receipt)
    && Object.keys(receipt).length === 4 && receipt.fileId === id && receipt.blockId === MCP_ROUTING_BLOCK_ID
    && receipt.bytes === MCP_ROUTING_BYTES && (receipt.state === 'active' || receipt.state === 'released'));

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const appliedOf = (value: unknown): Applied | undefined =>
  isRecord(value) && typeof value.commit === 'string' && COMMIT.test(value.commit)
    && typeof value.at === 'string' && !Number.isNaN(Date.parse(value.at))
    ? { commit: value.commit, at: value.at }
    : undefined;

// Legacy malformed records are absent; routing-bearing malformed records retain a conflict. The
// legacy machine choices (skillsOnly, configTargets) are not state: they live in overrides.json.
export const parseState = (text: string): MachineState | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return /"mcpRouting"\s*:/.test(text) ? { ...emptyState, mcpRouting: { invalid: text } } : undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (!isRecord(parsed.files)) return Object.hasOwn(parsed, 'mcpRouting')
    ? { ...emptyState, mcpRouting: { invalid: parsed.mcpRouting } } : undefined;
  const applied = appliedOf(parsed.applied);
  return {
    version: 1,
    repo: typeof parsed.repo === 'string' ? parsed.repo : null,
    files: parsed.files as Record<string, Baseline>,
    ...(applied ? { applied } : {}),
    ...(Object.hasOwn(parsed, 'mcpRouting') ? { mcpRouting: parsed.mcpRouting } : {}),
  };
};

export const withBaseline = (state: MachineState, key: string, hash: string, now = new Date()): MachineState => ({
  ...state,
  files: { ...state.files, [key]: { hash, appliedAt: now.toISOString() } },
});

export const withoutBaseline = (state: MachineState, key: string): MachineState => {
  const { [key]: _removed, ...files } = state.files;
  return { ...state, files };
};

export const withApplied = (state: MachineState, commit: string, now = new Date()): MachineState => ({
  ...state,
  applied: { commit, at: now.toISOString() },
});

export class StateStore extends Context.Service<
  StateStore,
  {
    readonly read: Effect.Effect<MachineState, FsFailed>;
    readonly write: (state: MachineState) => Effect.Effect<void, FsFailed>;
    readonly update: (f: (state: MachineState) => MachineState) => Effect.Effect<MachineState, FsFailed>;
  }
>()('machine/StateStore') {}

// state.json: nortuscc's own bookkeeping (the repo, per-file baselines and the applied setup commit),
// in the format earlier releases wrote plus optional applied commit and local routing ownership.
export const stateStore = Layer.effect(
  StateStore,
  Effect.gen(function* () {
    const paths = yield* MachinePaths;
    const fs = yield* Fs;
    const statePath = join(paths.stateRoot, 'state.json');
    const overridesPath = join(paths.stateRoot, 'overrides.json');
    const legacyPath = join(paths.claude, '.nortuscc-lock.json');

    // The first state write migrates the legacy machine choices from the on-disk state.json into
    // overrides.json, unless that file already exists; reads never write it. state.json is then
    // written without them.
    const write = (state: MachineState) => Effect.gen(function* () {
      if ((yield* fs.readText(overridesPath)) === undefined) {
        const legacy = overridesFromLegacyState(yield* fs.readText(statePath)).value;
        if (Object.keys(legacy).length > 0) {
          yield* fs.writeTextAtomic(overridesPath, JSON.stringify({ version: 1, ...legacy }, null, 2) + '\n');
        }
      }
      const { version, repo, files, applied } = state;
      yield* fs.writeTextAtomic(statePath, JSON.stringify({ version, repo, files, ...(applied ? { applied } : {}), ...(Object.hasOwn(state, 'mcpRouting') ? { mcpRouting: state.mcpRouting } : {}) }, null, 2) + '\n');
    });

    // Migrates the pre-Codex lock only when no state file exists; the old lock is left untouched.
    const read = Effect.gen(function* () {
      const text = yield* fs.readText(statePath);
      if (text !== undefined) return parseState(text) ?? emptyState;
      const legacyText = yield* fs.readText(legacyPath);
      const legacy = legacyText === undefined ? undefined : parseState(legacyText);
      if (!legacy) return emptyState;
      const files: Record<string, Baseline> = {};
      for (const [oldKey, newKey] of Object.entries(LEGACY_KEYS)) {
        if (legacy.files[oldKey]) files[newKey] = legacy.files[oldKey];
      }
      const migrated: MachineState = { ...emptyState, repo: legacy.repo, files,
        ...(Object.hasOwn(legacy, 'mcpRouting') ? { mcpRouting: legacy.mcpRouting } : {}) };
      yield* write(migrated);
      return migrated;
    });

    return {
      read,
      write,
      update: (f) => Effect.flatMap(read, (state) => {
        const next = f(state);
        return Effect.as(write(next), next);
      }),
    };
  }),
);
