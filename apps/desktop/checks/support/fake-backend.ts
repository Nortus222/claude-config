import { startBackend } from '../../backend/server.ts';
import { fakeDomain } from './fake-domains.ts';

// The real server and session over the fake domain, for stdio tests.
await startBackend([fakeDomain], { tools: [] });
