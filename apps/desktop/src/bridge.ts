import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Schema } from 'effect';
import { decodeMessage, type Progress } from '../backend/protocol.ts';
import type { Fixture } from '../backend/fixture.ts';
export type Command =
  | 'inspect_fixture'
  | 'start_fixture'
  | 'cancel_fixture'
  | 'restart_backend'
  | 'crash_probe';
export type HostEvent = (Progress | { event: 'disconnected'; detail: string }) & {
  generation: number;
};
export type Envelope = { generation: number; data: unknown };
export interface Bridge {
  subscribe(receive: (event: HostEvent) => void): Promise<() => void>;
  invoke(command: Command): Promise<Envelope>;
}
const Scalar = Schema.Union([Schema.String, Schema.Boolean]);
const FixtureSchema = Schema.Struct({
  profile: Schema.String,
  machine: Schema.String,
  rows: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      base: Scalar,
      override: Schema.Union([Scalar, Schema.Null]),
      desired: Scalar,
      current: Scalar,
      source: Schema.Literals(['base profile', 'machine override']),
      changed: Schema.Boolean,
    }),
  ),
  diff: Schema.Array(Schema.Struct({ key: Schema.String, before: Scalar, after: Scalar })),
});
export const decodeFixture = (value: unknown): Fixture =>
  Schema.decodeUnknownSync(FixtureSchema, { onExcessProperty: 'error' })(value);
const HostEnvelope = Schema.Struct({
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  data: Schema.Unknown,
});
const Disconnected = Schema.Struct({
  event: Schema.Literal('disconnected'),
  detail: Schema.String,
});
export function decodeHostEvent(value: unknown): HostEvent {
  if (typeof value !== 'object' || value === null || !('generation' in value))
    throw new Error('Missing host generation');
  const { generation, ...message } = value;
  const checked = Schema.decodeUnknownSync(Schema.Int.check(Schema.isGreaterThan(0)))(generation);
  if ('event' in message && message.event === 'disconnected')
    return {
      ...Schema.decodeUnknownSync(Disconnected, { onExcessProperty: 'error' })(message),
      generation: checked,
    };
  const progress = decodeMessage(message);
  if (!('event' in progress)) throw new Error('Expected host event');
  return { ...progress, generation: checked };
}
export const nativeAvailable = () => '__TAURI_INTERNALS__' in window;
export const nativeBridge: Bridge = {
  subscribe: (receive) =>
    listen<unknown>('fixture-backend', (event) => {
      try {
        receive(decodeHostEvent(event.payload));
      } catch (error) {
        console.error('Invalid host event', error);
      }
    }),
  invoke: async (command) =>
    Schema.decodeUnknownSync(HostEnvelope, { onExcessProperty: 'error' })(await invoke(command)),
};
