import { registerSetupsContract } from './support/setups-contract.ts';
import { memoryServiceStore } from './support/service-contract.ts';

registerSetupsContract('memory', memoryServiceStore);
