import { Context, type Effect } from 'effect';
import type { ServiceFailure } from './errors.ts';
export interface GitHubDevice { readonly deviceCode: string; readonly userCode: string; readonly verificationUri: string; readonly interval: number; readonly expiresIn: number }
export type GitHubExchange = { readonly type: 'pending' | 'slow-down' | 'expired' | 'denied' } | { readonly type: 'success'; readonly token: string };
export interface GitHubUser { readonly id: number; readonly login: string }
export class GitHub extends Context.Service<GitHub, {
  readonly requestDevice: () => Effect.Effect<GitHubDevice, ServiceFailure>;
  readonly exchange: (deviceCode: string) => Effect.Effect<GitHubExchange, ServiceFailure>;
  readonly user: (token: string) => Effect.Effect<GitHubUser, ServiceFailure>;
}>()('hosted/GitHub') {}
