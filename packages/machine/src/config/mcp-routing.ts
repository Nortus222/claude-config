import { join } from 'node:path';
import { Effect } from 'effect';
import type { DesiredConfig, ResolvedFile } from '@nortuscc/profile-engine';
import { acquireApplyLock } from '../apply-lock.ts';
import { Backups } from '../backups.ts';
import { MaintenancePending } from '../errors.ts';
import { Fs } from '../fs.ts';
import { hashText } from '../hash.ts';
import { MachinePaths } from '../paths.ts';
import {
  isMcpRoutingFileId, MCP_ROUTING_BLOCK_ID, MCP_ROUTING_BYTES, MCP_ROUTING_GUIDANCE,
  StateStore, validMcpRouting, type MachineState, type McpRoutingFileId, type McpRoutingReceipt,
} from '../state.ts';

export { MCP_ROUTING_BYTES, MCP_ROUTING_TEXT } from '../state.ts';

export const routingFile = (file: ResolvedFile): boolean => isMcpRoutingFileId(file.id)
  && file.mode === 'copy' && file.home === file.target && !file.preserveProjects
  && (file.id === 'claude:CLAUDE.md'
    ? file.home === 'claude' && file.dest === 'CLAUDE.md' && file.src === 'claude/CLAUDE.md'
    : file.home === 'codex' && file.dest === 'AGENTS.md' && file.src === 'codex/AGENTS.md');

export type RoutingSplit = {
  readonly body: string | undefined;
  readonly status: 'absent' | 'owned' | 'conflict';
  readonly receipt?: McpRoutingReceipt;
  readonly note?: string;
};
const marked = (text: string | undefined) => text?.includes('nortuscc:mcp-routing:') ?? false;

// Only the exact recorded span establishes ownership. A marker alone never does.
export const splitMcpRouting = (text: string | undefined, fileId: string, ownership: unknown): RoutingSplit => {
  if (!isMcpRoutingFileId(fileId)) return { body: text, status: 'absent' };
  if (ownership !== undefined && !validMcpRouting(ownership)) {
    return { body: text, status: 'conflict', note: 'MCP routing ownership metadata is invalid; repair it before changing instructions' };
  }
  const receipt = ownership?.files[fileId];
  const at = receipt && text !== undefined ? text.indexOf(receipt.bytes) : -1;
  if (at !== -1 && receipt && text !== undefined) {
    const body = text.slice(0, at) + text.slice(at + receipt.bytes.length);
    if (!marked(body)) return { body, status: 'owned', receipt };
  } else if (!marked(text)) return { body: text, status: 'absent', ...(receipt ? { receipt } : {}) };
  return { body: text, status: 'conflict', ...(receipt ? { receipt } : {}), note: 'MCP routing block is edited, duplicated, or foreign; repair it before changing instructions' };
};

export const releasedRouting = (state: MachineState, fileId: string): MachineState => {
  if (!isMcpRoutingFileId(fileId) || !validMcpRouting(state.mcpRouting)) return state;
  const receipt = state.mcpRouting.files[fileId];
  if (!receipt) return state;
  return { ...state, mcpRouting: { ...state.mcpRouting, files: { ...state.mcpRouting.files, [fileId]: { ...receipt, state: 'released' } } } };
};

export type McpRoutingStatus = {
  readonly fileId: McpRoutingFileId;
  readonly blockId: typeof MCP_ROUTING_BLOCK_ID;
  readonly status: 'installed' | 'missing' | 'released' | 'absent' | 'unmanaged' | 'conflict';
  readonly intent: 'active' | 'released' | 'unowned' | 'invalid';
  readonly blockStatus: 'present' | 'absent' | 'conflict';
  readonly evidence: string;
  readonly offeredText: string;
  readonly note?: string;
};
export type McpRoutingResult = McpRoutingStatus & {
  readonly outcome: 'changed' | 'unchanged' | 'conflict' | 'unmanaged';
  readonly intentChanged: boolean;
  readonly instructionsChanged: boolean;
};

const routingEvidence = (text: string | undefined, ownership: unknown, managed: boolean) =>
  hashText(JSON.stringify({ text, ownership, managed }));

const readRouting = (desired: DesiredConfig, fileId: McpRoutingFileId) => Effect.gen(function* () {
  const fs = yield* Fs;
  const paths = yield* MachinePaths;
  const state = yield* (yield* StateStore).read;
  const file = desired.files.find(f => f.id === fileId && routingFile(f));
  // Disconnect still owns this fixed location after config management is disabled.
  const dest = fileId === 'claude:CLAUDE.md' ? join(paths.claude, 'CLAUDE.md') : join(paths.codex, 'AGENTS.md');
  const text = yield* fs.readText(dest);
  const split = splitMcpRouting(text, fileId, state.mcpRouting);
  const evidence = routingEvidence(text, state.mcpRouting, file?.managed ?? false);
  const status: McpRoutingStatus = {
    fileId, blockId: MCP_ROUTING_BLOCK_ID, evidence, offeredText: MCP_ROUTING_GUIDANCE,
    intent: state.mcpRouting !== undefined && !validMcpRouting(state.mcpRouting) ? 'invalid' : split.receipt?.state ?? 'unowned',
    blockStatus: split.status === 'owned' ? 'present' : split.status,
    status: split.status === 'conflict' ? 'conflict' : !file?.managed ? 'unmanaged'
      : split.receipt?.state === 'released' ? 'released' : split.status === 'owned' ? 'installed'
      : split.receipt?.state === 'active' ? 'missing' : 'absent',
    ...(split.note ? { note: split.note } : {}),
  };
  return { status, split, state, file, dest, text };
});

export const inspectMcpRouting = (desired: DesiredConfig, fileId: McpRoutingFileId) =>
  Effect.map(readRouting(desired, fileId), ({ status }) => status);

// Caller-owned lock scopes must hold acquireApplyLock across preview revalidation and this call.
// Persist the receipt before editing, so interrupted connect/remove can be retried from exact evidence.
export const setMcpRouting = (
  desired: DesiredConfig, fileId: McpRoutingFileId, active: boolean, expectedEvidence: string,
  options: { readonly lockHeld?: boolean } = {},
) => Effect.scoped(Effect.gen(function* () {
  if (!options.lockHeld) yield* acquireApplyLock;
  const fs = yield* Fs;
  const paths = yield* MachinePaths;
  if (yield* fs.stat(join(paths.stateRoot, 'agent/pending-update.json'))) return yield* Effect.fail(new MaintenancePending());
  const now = yield* readRouting(desired, fileId);
  const result = (outcome: McpRoutingResult['outcome'], note?: string): McpRoutingResult => ({ ...now.status, outcome, intentChanged: false, instructionsChanged: false, ...(note ? { note } : {}) });
  if (now.status.evidence !== expectedEvidence) return result('conflict', 'Instructions or ownership changed since inspection; inspect again');
  if (now.split.status === 'conflict' && (active || now.split.receipt?.state !== 'active')) return result('conflict');
  if (active && !now.file?.managed) return result('unmanaged');
  const receipt = now.split.receipt;
  if (active && receipt?.state === 'active' && now.split.status === 'owned') return result('unchanged');
  if (!active && !receipt) return result('unchanged');
  if (!active && receipt?.state === 'released' && now.split.status === 'absent') return result('unchanged');
  const nextReceipt: McpRoutingReceipt = { fileId, blockId: MCP_ROUTING_BLOCK_ID, bytes: MCP_ROUTING_BYTES, state: active ? 'active' : 'released' };
  const ownership = validMcpRouting(now.state.mcpRouting) ? now.state.mcpRouting.files : {};
  const next = { ...now.state, mcpRouting: { version: 1, files: { ...ownership, [fileId]: nextReceipt } } };
  const nextText = now.split.status === 'conflict' ? now.text
    : active ? now.split.status === 'owned' ? now.text : (now.split.body ?? '') + MCP_ROUTING_BYTES : now.split.body;
  const intentChanged = receipt?.state !== nextReceipt.state;
  const backups = yield* Backups;
  // Routing backups are not config originals: uninstall must not restore an earlier managed body.
  yield* backups.preserve(now.dest, join('mcp-routing', fileId.replace(':', '/')));
  yield* backups.preserve(join(paths.stateRoot, 'state.json'), 'state.json');
  const fresh = yield* readRouting(desired, fileId);
  if (fresh.status.evidence !== expectedEvidence) return result('conflict', 'Instructions or ownership changed before writing; inspect again');
  yield* (yield* StateStore).write(next);
  // A failed write leaves durable active/missing or released/present ownership for repair.
  const persisted = yield* inspectMcpRouting(desired, fileId);
  if (persisted.evidence !== routingEvidence(now.text, next.mcpRouting, now.file?.managed ?? false)) return {
    ...persisted, outcome: 'conflict', intentChanged, instructionsChanged: false,
    note: 'Instructions changed before writing; ownership was retained for repair',
  } satisfies McpRoutingResult;
  if (nextText !== now.text && nextText !== undefined) yield* fs.writeTextAtomic(now.dest, nextText);
  const after = yield* inspectMcpRouting(desired, fileId);
  return { ...after, outcome: after.blockStatus === 'conflict' ? 'conflict' : 'changed', intentChanged, instructionsChanged: nextText !== now.text } satisfies McpRoutingResult;
}));
