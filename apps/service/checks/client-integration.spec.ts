import { registerClientIntegrationContract } from './support/client-integration-contract.ts';
import { memoryServiceStore } from './support/service-contract.ts';

registerClientIntegrationContract('Memory', memoryServiceStore);
