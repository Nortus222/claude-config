import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Schema } from 'effect';
import { decodeMessage, type RunEvent, type StatusEvent } from '@nortuscc/agent/ipc/protocol';

// The renderer's whole reach: these commands, with opaque keys and plan ids as their only arguments.
export type Command = 'agent_generation' | 'agent_status' | 'inspect_machine' | 'preview_plan' | 'apply_plan' | 'cancel_apply' | 'restart_agent' | 'take_review_request';
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
      } catch (error) {
        console.error('Invalid host event', error);
      }
    }),
  invoke: async (command, args) =>
    Schema.decodeUnknownSync(HostEnvelope, { onExcessProperty: 'error' })(await invoke(command, args)),
};
