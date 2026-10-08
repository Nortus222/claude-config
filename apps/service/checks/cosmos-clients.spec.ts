import test from 'node:test';
import { registerClientIntegrationContract } from './support/client-integration-contract.ts';
import { createCosmosFixture, emulatorConfigured, requireEmulatorConfiguration } from './support/cosmos.ts';
import type { ServiceStoreFactory } from './support/service-contract.ts';

if (process.env.NORTUSCC_COSMOS_REQUIRED === '1') requireEmulatorConfiguration();

if (emulatorConfigured()) {
  const factory: ServiceStoreFactory = ({ now }) => createCosmosFixture({ now, pageSize: 7 });
  registerClientIntegrationContract('Cosmos emulator', factory);
} else {
  test('Cosmos emulator actual HTTP clients', { skip: 'Local Cosmos emulator is not configured.' }, () => {});
}
