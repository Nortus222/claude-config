import { domains } from './domains.ts';
import { startBackend } from './server.ts';

// The desktop backend: one session over this user's machine, served to the Rust host on stdio.
await startBackend(domains);
