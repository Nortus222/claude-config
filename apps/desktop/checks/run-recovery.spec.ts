import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunRecovery } from '../src/run-recovery.tsx';
import { run } from './support/setup-sync.ts';

const summary = (html: string) => html.replace(/<details class="run-details"[\s\S]*?<\/details>/, '');

test('an interrupted run names its change, counts its evidence and offers Re-preview and Abandon', () => {
  const html = renderToStaticMarkup(createElement(RunRecovery, { run: run({ state: 'interrupted', result: { status: 'interrupted', message: 'Restarted' } }), onRepreview: () => {}, onAbandon: () => {} }));
  assert.match(html, /Apply incoming changes was interrupted/);
  assert.match(html, /1 change was written and 1 was not/); assert.match(html, /Backups of what it replaced are kept/);
  assert.match(html, />Re-preview<\/button>/); assert.match(html, />Abandon<\/button>/);
  assert.doesNotMatch(summary(html), /setup-run|setting:a|setting:b|backup-1/);
  for (const text of ['setup-run', 'setting:a', 'setting:b', 'backup-1']) assert.ok(html.includes(text), text);
});
test('abandoned receipts keep their counts and offer no recovery actions', () => {
  const html = renderToStaticMarkup(createElement(RunRecovery, { run: run({ state: 'abandoned', result: { status: 'interrupted', message: 'Abandoned' } }), onRepreview: () => {}, onAbandon: () => {} }));
  assert.match(html, /Apply incoming changes was abandoned/); assert.match(html, /1 change was written and 1 was not/); assert.doesNotMatch(html, /<button/);
});
