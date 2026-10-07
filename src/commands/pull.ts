// `nortuscc pull` is `nortuscc sync`: status's self-update and scripts keep calling it, and without
// a terminal it takes every item and keeps every override, as pull always did.
export { run } from './sync.ts';
