import { registerExpiryContract } from './support/expiry-contract.ts';
import { memoryServiceStore } from './support/service-contract.ts';

registerExpiryContract('memory', memoryServiceStore);
