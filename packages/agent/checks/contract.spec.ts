import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sync from '@nortuscc/sync';
import * as agent from '../src/index.ts';

// Machine sync owns the contract; the agent must hand out the very same values, never copies, so a
// Layer built for one is the service the other asks for.
const MOVED = [
  'SetupSource', 'RevisionMismatch', 'RevisionUnavailable', 'LOCAL_SETUP', 'itemIdOf', 'entryOf',
  'SetupsStore', 'setupsStore', 'normalizeRepoUrl', 'ownSetup',
] as const;

for (const name of MOVED) {
  test(`the agent re-exports ${name} from @nortuscc/sync`, () => {
    assert.equal(agent[name], sync[name]);
  });
}
