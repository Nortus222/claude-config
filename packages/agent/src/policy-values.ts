// Policy values shared by the agent state and browser-safe wire contract.
export const POLICIES = ['auto-apply', 'notify', 'manual'] as const;
export type Policy = typeof POLICIES[number];
