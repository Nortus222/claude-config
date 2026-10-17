import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunRecovery } from '../src/run-recovery.tsx';
import { run } from './support/setup-sync.ts';

const ask = { onAskAbandon: () => {}, onKeep: () => {}, confirming: false };
const summary = (html: string) => html.replace(/<details class="run-details"[\s\S]*?<\/details>/, '');

test('an interrupted run names its change, counts its evidence and offers Re-preview and Abandon', () => {
  const html = renderToStaticMarkup(createElement(RunRecovery, { run: run({ state: 'interrupted', result: { status: 'interrupted', message: 'Restarted' } }), onRepreview: () => {}, onAbandon: () => {}, ...ask }));
  assert.match(html, /Apply incoming changes was interrupted/);
  assert.match(html, /1 change was written and 1 was not/); assert.match(html, /Backups of what it replaced are kept/);
  assert.match(html, />Re-preview<\/button>/); assert.match(html, />Abandon<\/button>/);
  assert.doesNotMatch(summary(html), /setup-run|setting:a|setting:b|backup-1/);
  for (const text of ['setup-run', 'setting:a', 'setting:b', 'backup-1']) assert.ok(html.includes(text), text);
});
test('an interrupted run says why above its counts and keeps where to look under Details', () => {
  const interrupted = run({ state: 'interrupted', result: { status: 'interrupted', message: 'Agent stopped while applying Claude setting model; inspect before trying again' } });
  const html = renderToStaticMarkup(createElement(RunRecovery, { run: interrupted, onRepreview: () => {}, onAbandon: () => {}, ...ask, report: 'report text' }));
  assert.match(html, /<p class="run-cause">Agent stopped while applying Claude setting model\.<\/p><p class="muted">1 change was written/);
  assert.doesNotMatch(summary(html), /inspect/i);
  assert.match(html, />Copy details<\/button>/);
  assert.match(html, /<details class="run-details">[\s\S]*Agent log[\s\S]*~\/\.config\/nortuscc\/agent\/agent\.log[\s\S]*~\/\.config\/nortuscc\/backups\/backup-1/);
  const abandoned = renderToStaticMarkup(createElement(RunRecovery, { run: run({ state: 'abandoned', result: { status: 'interrupted', message: 'Abandoned' } }), onRepreview: () => {}, onAbandon: () => {}, ...ask }));
  assert.doesNotMatch(abandoned, /run-cause/);
});
test('abandoned receipts keep their counts and offer no recovery actions', () => {
  const html = renderToStaticMarkup(createElement(RunRecovery, { run: run({ state: 'abandoned', result: { status: 'interrupted', message: 'Abandoned' } }), onRepreview: () => {}, onAbandon: () => {}, ...ask }));
  assert.match(html, /Apply incoming changes was abandoned/); assert.match(html, /1 change was written and 1 was not/); assert.doesNotMatch(html, /<button/);
});
test('Abandon asks once, naming the run and its effect, before abandoning', () => {
  const html = renderToStaticMarkup(createElement(RunRecovery, { run: run({ state: 'interrupted', result: { status: 'interrupted', message: 'Restarted' } }), onRepreview: () => {}, onAbandon: () => {}, ...ask, confirming: true }));
  assert.match(html, /Abandon “Apply incoming changes”\? Its remaining steps won’t run\. Finished steps and backups are kept\./);
  assert.match(html, /<button class="danger">Abandon<\/button><button>Keep<\/button>/); assert.doesNotMatch(html, />Re-preview</);
});
