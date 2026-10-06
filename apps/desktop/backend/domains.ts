import { configDomain, integrationsDomain, skillsDomain, type Domain } from '@nortuscc/machine';
import type { DesktopServices, DomainContext } from './session.ts';

// The domains this build inspects and applies, in run order, for the machine an inspect resolved.
// Installer output is inherited; the session's services send it to stderr, off the protocol channel.
export const domains = ({ paths, env }: DomainContext): ReadonlyArray<Domain<DesktopServices>> => [
  configDomain,
  integrationsDomain({ paths, env }),
  skillsDomain,
];
