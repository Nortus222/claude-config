import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/service.ts';

test('service fixtures share an injected clock across restarted handlers', async () => {
  const clock = { now: Date.UTC(2026, 9, 7) };
  const first = await fixture({ clock });
  const second = await fixture({ store: first.store, clock });
  try {
    const pending = await first.start();
    assert.equal(first.clock, clock);
    assert.equal(second.clock, clock);
    clock.now += 900000;
    assert.equal((await second.call('POST', '/v1/auth/device/poll', { pendingId: pending.body.pendingId })).status, 410);
  } finally { await first.close(); await second.close(); }
});
