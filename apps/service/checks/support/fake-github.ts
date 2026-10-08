import { Effect } from 'effect';
import type { GitHub, GitHubExchange, GitHubUser } from '../../src/github.ts';

export function fakeGitHub() {
  let barrier: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const state = { calls: 0, exchange: { type: 'success', token: 'PRIVATE_OAUTH_TOKEN' } as GitHubExchange,
    user: { id: 42, login: 'Ihor' } as GitHubUser, expiresIn: 1200 };
  const service: GitHub['Service'] = {
    requestDevice: () => Effect.sync(() => ({ deviceCode: 'PRIVATE_DEVICE_CODE', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: state.expiresIn })),
    exchange: () => Effect.promise(async () => { state.calls++; if (barrier) await barrier; return state.exchange; }),
    user: () => Effect.sync(() => state.user),
  };
  return { state, service, hold: () => { barrier = new Promise<void>((resolve) => { release = resolve; }); }, release: () => { release?.(); barrier = undefined; } };
}
