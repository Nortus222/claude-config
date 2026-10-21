import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceCopy, fileManager, thisMachine } from '../src/device.ts';

test('the Windows host is named this PC with File Explorer; anything else keeps the macOS wording', () => {
  assert.deepEqual(deviceCopy('windows'), { thisMachine: 'this PC', ThisMachine: 'This PC', THIS_MACHINE: 'THIS PC', fileManager: 'File Explorer', agentLifetime: 'The agent runs while Nortuscc is open.' });
  const mac = { thisMachine: 'this Mac', ThisMachine: 'This Mac', THIS_MACHINE: 'THIS MAC', fileManager: 'Finder', agentLifetime: 'The background agent keeps working when this window is closed.' };
  for (const platform of [undefined, 'macos', 'linux', 42]) assert.deepEqual(deviceCopy(platform), mac);
  // No host declaration (macOS, tests, browser preview) reads as macOS.
  assert.equal(thisMachine, 'this Mac'); assert.equal(fileManager, 'Finder');
});
