import { registerDecisionsContract } from './support/decisions-contract.ts';
import { memoryServiceStore } from './support/service-contract.ts';

registerDecisionsContract('memory', memoryServiceStore);
