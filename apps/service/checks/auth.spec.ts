import { registerAuthContract } from './support/auth-contract.ts';
import { memoryServiceStore } from './support/service-contract.ts';

registerAuthContract('memory', memoryServiceStore);
