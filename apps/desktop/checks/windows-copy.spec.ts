import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The Windows host declares its platform before any renderer module loads; this file runs in its own process.
(globalThis as { __NORTUSCC_PLATFORM__?: string }).__NORTUSCC_PLATFORM__ = 'windows';
const { SetupView, ShellView } = await import('../src/views.tsx');
const { RunPlaces } = await import('../src/run-recovery.tsx');
const { SetupController } = await import('../src/setup-controller.ts');
const { MachineController } = await import('../src/controller.ts');
const { changeTitle } = await import('../src/copy.ts');

test('on Windows the startup card, first run and reveal name this PC and File Explorer', () => {
  const machine = new MachineController(null); const setup = new SetupController(null, machine);
  const startup = renderToStaticMarkup(createElement(SetupView, { state: { ...setup.state, phase: 'checking' }, controller: setup }));
  assert.match(startup, /NORTUSCC \/ THIS PC/); assert.match(startup, /Checking this PC/); assert.match(startup, /finishes checking this PC\./);
  const needed = renderToStaticMarkup(createElement(SetupView, { state: { ...setup.state, phase: 'needed' }, controller: setup }));
  assert.match(needed, /Set up this PC/);
  const places = renderToStaticMarkup(createElement(RunPlaces, { backupIds: [], onReveal: async () => null }));
  assert.match(places, />Show in File Explorer</); assert.match(places, /aria-label="Show the agent log in File Explorer"/);
  for (const markup of [startup, needed, places]) assert.doesNotMatch(markup, /\bMac\b|Finder/);
  const shell = renderToStaticMarkup(createElement(ShellView, { screen: 'home', navigate: () => {}, machine: machine.state, children: null }));
  assert.match(shell, />THIS PC</); assert.doesNotMatch(shell, /THIS MAC/);
  assert.equal(changeTitle('reconcile'), 'Apply changes to this PC');
});
