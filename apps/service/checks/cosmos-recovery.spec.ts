import test from 'node:test';
import { registerAuthContract } from './support/auth-contract.ts';
import { registerSetupsContract } from './support/setups-contract.ts';
import { registerRevisionsContract } from './support/revisions-contract.ts';
import { registerDecisionsContract } from './support/decisions-contract.ts';
import { registerDeletionContract } from './support/deletion-contract.ts';
import { createCosmosFixture, emulatorConfigured, requireEmulatorConfiguration } from './support/cosmos.ts';
import type { ServiceStoreFactory } from './support/service-contract.ts';

if (process.env.NORTUSCC_COSMOS_REQUIRED === '1') requireEmulatorConfiguration();

if (emulatorConfigured()) {
  const factory: ServiceStoreFactory = ({ now }) => createCosmosFixture({ now, pageSize: 7 });
  for (const register of [registerAuthContract, registerSetupsContract, registerRevisionsContract, registerDecisionsContract, registerDeletionContract]) {
    register('Cosmos emulator', factory);
  }
} else {
  test('Cosmos emulator service recovery contracts', { skip: 'Local Cosmos emulator is not configured.' }, () => {});
}
