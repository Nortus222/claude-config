import { registerRevisionsContract } from './support/revisions-contract.ts';
import { memoryServiceStore } from './support/service-contract.ts';

registerRevisionsContract('memory', memoryServiceStore);
