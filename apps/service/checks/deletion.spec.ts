import { registerDeletionContract } from './support/deletion-contract.ts';
import { memoryServiceStore } from './support/service-contract.ts';

registerDeletionContract('memory', memoryServiceStore);
