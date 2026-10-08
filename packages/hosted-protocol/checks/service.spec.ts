import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/index.ts';
test('health has a minimal strict public projection', () => {
  assert.ok('HealthResponseSchema' in api, 'HealthResponseSchema must be exported');
  assert.deepEqual(api.decodeHosted(api.HealthResponseSchema, { status: 'ok' }), { status: 'ok' });
  assert.throws(() => api.decodeHosted(api.HealthResponseSchema, { status: 'ok', private: 'secret' }));
});
