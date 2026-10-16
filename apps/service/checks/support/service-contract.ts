import test from 'node:test';
import { makeMemoryStore } from '../../src/memory-store.ts';
import type { Store } from '../../src/store.ts';
import { fixture, type FixtureOptions } from './service.ts';

export interface ServiceStoreFixture {
  readonly store: Store['Service'];
  readonly restart: () => Store['Service'] | Promise<Store['Service']>;
  readonly dispose: () => Promise<void>;
}
export type ServiceStoreFactory = (options: { now: () => number }) => Promise<ServiceStoreFixture>;

export const memoryServiceStore: ServiceStoreFactory = async () => {
  const store = makeMemoryStore();
  return { store, restart: () => store, dispose: async () => {} };
};

interface ServiceTestContext {
  readonly store: Store['Service'];
  readonly restartStore: ServiceStoreFixture['restart'];
  readonly fixture: (options?: FixtureOptions) => ReturnType<typeof fixture>;
}

// Each scenario owns one backend and clock, including replicas and restarted handlers.
export const serviceContract = (name: string, factory: ServiceStoreFactory) =>
  (label: string, run: (context: ServiceTestContext) => Promise<void>) => test(`${name}: ${label}`, async (t) => {
    const clock = { now: Date.UTC(2026, 9, 7) };
    const backend = await factory({ now: () => clock.now });
    t.after(backend.dispose);
    await run({
      store: backend.store,
      restartStore: backend.restart,
      fixture: (options = {}) => fixture({ ...options, store: options.store ?? backend.store, clock }),
    });
  });
