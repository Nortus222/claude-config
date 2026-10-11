import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdateView } from '../src/update-view.tsx';
import { UpdateController } from '../src/update-controller.ts';
import type { UpdateSnapshot } from '../shared/update-protocol.ts';
const update = (fields: Partial<UpdateSnapshot> = {}): UpdateSnapshot => ({ installedVersion: '0.1.0', enabled: true, automaticChecks: true, phase: 'available', availableVersion: '0.2.0', notes: null, downloadedBytes: 0, totalBytes: null, diagnostic: null, ...fields });
const render = (fields: Partial<UpdateSnapshot> = {}) => { const controller = new UpdateController(null); return renderToStaticMarkup(createElement(UpdateView, { controller, state: { ...controller.state, native: true, update: update(fields) } })); };
test('browser preview shows unknown installed version and disables checks and preferences without sample update data', () => {
  const controller = new UpdateController(null);
  const markup = renderToStaticMarkup(createElement(UpdateView, { controller, state: controller.state }));
  assert.match(markup, /Installed version: Unknown/); assert.match(markup, /Browser preview/);
  assert.match(markup, /button disabled=""[^>]*>Check for updates/); assert.match(markup, /type="checkbox" disabled=""/);
  assert.doesNotMatch(markup, /0\.1\.0|0\.2\.0|Install and restart|Download update/);
});
test('notes are plain text and availability never implies verified or installable bytes', () => {
  const markup = render({ notes: '<img src=x onerror=alert(1)>\n[link](https://evil.test)' });
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(markup, /<img|<a |Install and restart|Ready to install/);
  assert.match(markup, /Download update/); assert.match(markup, /Later/);
  const verified = render({ phase: 'verified' }); assert.match(verified, /Ready to install/); assert.match(verified, /Install and restart/);
});
test('download progress supports unknown and known lengths and only downloading or waiting can cancel', () => {
  const unknown = render({ phase: 'downloading', downloadedBytes: 120 });
  assert.match(unknown, /120 bytes/); assert.match(unknown, /<progress aria-label="Update download"/); assert.doesNotMatch(unknown, /value="/); assert.match(unknown, /Cancel/);
  const known = render({ phase: 'downloading', downloadedBytes: 50, totalBytes: 100 }); assert.match(known, /value="50" max="100"/);
  assert.match(render({ phase: 'waiting' }), /Waiting for configuration apply/); assert.match(render({ phase: 'waiting' }), /Cancel/);
  assert.doesNotMatch(render({ phase: 'installing' }), />Cancel</); assert.doesNotMatch(render({ phase: 'restarting' }), /Install and restart/);
});
test('disabled production config reports real installed version and bounded native reason with no enabled controls', () => {
  const markup = render({ enabled: false, phase: 'idle', availableVersion: null, diagnostic: 'Production updater configuration is absent.' });
  assert.match(markup, /Installed version: 0.1.0/); assert.match(markup, /Production updater configuration is absent/);
  assert.match(markup, /button disabled=""[^>]*>Check for updates/); assert.match(markup, /type="checkbox" disabled=""/);
});
test('native error and recovery are distinct from ready state and expose appropriate retry feedback', () => {
  assert.match(render({ phase: 'error', diagnostic: '<failed>' }), /&lt;failed&gt;/);
  assert.doesNotMatch(render({ phase: 'recovery' }), /Ready to install|Install and restart|Download update/);
  const controller = new UpdateController(null);
  const markup = renderToStaticMarkup(createElement(UpdateView, { controller, state: { ...controller.state, native: true, update: update({ phase: 'error' }), retry: 'install', detail: 'Update installation failed.' } }));
  assert.match(markup, /Retry install/); assert.doesNotMatch(markup, /Ready to install/);
});


test('native startup read failure keeps a retry control available while version remains unknown', () => {
  const controller = new UpdateController(null);
  const markup = renderToStaticMarkup(createElement(UpdateView, { controller, state: { ...controller.state, native: true, retry: 'check', detail: 'Update action failed.' } }));
  assert.match(markup, /Installed version: Unknown/);
  assert.match(markup, /<button>Retry check<\/button>/);
});
