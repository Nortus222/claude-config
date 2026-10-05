import type { Domain } from '@nortuscc/machine';
import type { DesktopServices } from './session.ts';

// The domains this build inspects and applies, in run order. Config (#55), integrations (#56)
// and skills (#57) join here as they merge; until then a real inspect reports no items.
export const domains: ReadonlyArray<Domain<DesktopServices>> = [];
