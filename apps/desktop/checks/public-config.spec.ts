import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopHostedUrl } from '../agent/public-config.ts';

test('desktop public endpoint preserves explicit URL overrides and can explicitly remain local-only', () => {
  assert.equal(desktopHostedUrl({}), 'https://claude-config-prod-service.livelypebble-1d07564b.westus2.azurecontainerapps.io/v1');
  assert.equal(desktopHostedUrl({ NORTUSCC_HOSTED_URL: 'https://custom.invalid/v1' }), 'https://custom.invalid/v1');
  assert.equal(desktopHostedUrl({ NORTUSCC_HOSTED_URL: '' }), '');
  assert.equal(desktopHostedUrl({ NORTUSCC_HOSTED_URL: 'bad' }), 'bad');
  assert.equal(desktopHostedUrl({ NORTUSCC_DESKTOP_LOCAL_ONLY: '1', NORTUSCC_HOSTED_URL: 'https://custom.invalid/v1' }), undefined);
  for (const value of ['', '0', 'true']) assert.throws(() => desktopHostedUrl({ NORTUSCC_DESKTOP_LOCAL_ONLY: value }), /LOCAL_ONLY/);
});
