import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunRecovery } from '../src/run-recovery.tsx';
import { run } from './support/setup-sync.ts';

test('an interrupted run offers Re-preview and Abandon with committed, remaining and backup evidence', () => {
  const html = renderToStaticMarkup(createElement(RunRecovery, { run: run({ state: 'interrupted', result: { status: 'interrupted', message: 'Restarted' } }), onRepreview: () => {}, onAbandon: () => {} }));
  for (const text of ['Committed keys', 'Remaining keys', 'Backup IDs', 'setting:a', 'setting:b', 'backup-1', 'Re-preview', 'Abandon']) assert.ok(html.includes(text));
});
test('abandoned receipts retain evidence and offer no recovery actions', () => {
  const html = renderToStaticMarkup(createElement(RunRecovery, { run: run({ state: 'abandoned', result: { status: 'interrupted', message: 'Abandoned' } }), onRepreview: () => {}, onAbandon: () => {} }));
  assert.match(html, /Abandoned/); assert.match(html, /backup-1/); assert.doesNotMatch(html, /<button/);
});
