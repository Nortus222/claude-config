import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Schema } from 'effect';
import { decodeUpdateSnapshot } from '../shared/update-protocol.ts';
import type { UpdateBridge } from './update-controller.ts';
import { decodeMessage, type RunEvent, type StatusEvent } from '@nortuscc/agent/ipc/protocol';

// Fixed native commands accept public metadata, enums and opaque IDs.
export type Command = 'mcp_connections' | 'agent_generation' | 'agent_status' | 'inspect_machine' | 'preview_plan' | 'apply_plan' | 'cancel_apply' | 'restart_agent' | 'take_review_request' | 'desktop_setup_state' | 'setup_desktop' | 'install_git' | 'hosted_state' | 'sign_in' | 'sign_out' | 'sync_now' | 'trust_setup' | 'machine_settings' | 'set_policy' | 'resume_agent' | 'open_device_login';
export type HostEvent = (RunEvent | StatusEvent | { event: 'disconnected'; detail: string } | { event: 'review-requested' }) & { generation: number };
export type Envelope = { generation: number; data: unknown };
export interface Bridge {
  subscribe(receive: (event: HostEvent) => void): Promise<() => void>;
  invoke(command: Command, args?: Readonly<Record<string, unknown>>): Promise<Envelope>;
}

const Generation = Schema.Int.check(Schema.isGreaterThan(0));
const HostEnvelope = Schema.Struct({ generation: Generation, data: Schema.Unknown });
const ReviewRequested = Schema.Struct({ event: Schema.Literal('review-requested') });
const Disconnected = Schema.Struct({ event: Schema.Literal('disconnected'), detail: Schema.String });

export function decodeHostEvent(value: unknown): HostEvent {
  if (typeof value !== 'object' || value === null || !('generation' in value)) throw new Error('Missing host generation');
  const { generation, ...message } = value;
  const checked = Schema.decodeUnknownSync(Generation)(generation);
  if ('event' in message && message.event === 'disconnected')
    return { ...Schema.decodeUnknownSync(Disconnected, { onExcessProperty: 'error' })(message), generation: checked };
  if ('event' in message && message.event === 'review-requested')
    return { ...Schema.decodeUnknownSync(ReviewRequested, { onExcessProperty: 'error' })(message), generation: checked };
  const decoded = decodeMessage(message);
  if (!('event' in decoded) || decoded.event === 'notification') throw new Error('Expected an agent event');
  return { ...decoded, generation: checked };
}

export const nativeAvailable = () => '__TAURI_INTERNALS__' in window;
export const nativeBridge: Bridge = {
  subscribe: (receive) =>
    listen<unknown>('machine-agent', (event) => {
      try {
        receive(decodeHostEvent(event.payload));
      } catch {
        console.error('Invalid host event');
      }
    }),
  invoke: async (command, args) => {
    const result = await invoke(command, args);
    try { return Schema.decodeUnknownSync(HostEnvelope, { onExcessProperty: 'error' })(result); }
    catch { throw new Error('Invalid native response'); }
  },
};

// Updater snapshots do not share the agent connection's generation envelope.
export const nativeUpdateBridge: UpdateBridge = {
  invoke: async (command, args) => {
    const result = await invoke(command, args);
    try { return decodeUpdateSnapshot(result); }
    catch { throw new Error('Invalid native update response'); }
  },
};
