import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupView, SettingsView, OverviewView, ResolvedView, ShellView, screenForReview } from '../src/views.tsx';
import { ReviewView } from '../src/review-view.tsx';
import { SetupController } from '../src/setup-controller.ts';
import { AccountController } from '../src/account-controller.ts';
import { MachineController } from '../src/controller.ts';
const machine = () => new MachineController(null);
test('browser preview has only implemented navigation and real empty states', () => {
  const c = machine();
  const markup = renderToStaticMarkup(createElement(ShellView, { screen: 'overview', navigate: () => {}, children: createElement(OverviewView, { state: c.state, navigate: () => {} }) }));
  for (const name of ['Claude Config', 'Overview', 'Review &amp; apply', 'Resolved', 'Settings']) assert.match(markup, new RegExp(name));
  for (const name of ['Discover', 'Machines', 'History', 'Publish', 'Updates', 'fixture-login']) assert.doesNotMatch(markup, new RegExp(name));
  assert.match(markup, /Browser preview/);
});
const status = { at: '2026-10-11T12:00:00Z', policy: 'notify' as const, paused: { at: 'now', reason: 'Cancelled' }, trusted: false, pending: [], drift: [], conflicts: [], probeErrors: [], counts: { pending: 3, held: 1, ready: 2, drift: 0 } };
const hosted = { enabled: true, recovered: true, signingIn: false, accountId: null, login: null, machineId: null, auth: 'signed-out' as const, setups: [], machine: null, lastSyncAt: null, retryAt: null, pollAfter: 900, error: null };
test('first run displays fixed consent, all four choices and explicit Git installer/recheck', () => {
  const c = machine(); const setup = new SetupController(null, c);
  const state = { ...setup.state, phase: 'needed' as const, setup: { needsSetup: true, repo: null, gitAvailable: false, canInstallGit: true, defaultRepoUrl: 'https://github.com/Nortus222/claude-config.git' as const } };
  const markup = renderToStaticMarkup(createElement(SetupView, { state, controller: setup }));
  for (const label of ['https://github.com/Nortus222/claude-config.git', 'Claude and Codex', 'Claude only', 'Codex only', 'Neither', 'Install Git', 'Recheck Git', 'Use this repository and set up']) assert.ok(markup.includes(label), label);
  assert.match(markup, /Apple/);
  const browser = renderToStaticMarkup(createElement(SetupView, { state: setup.state, controller: setup }));
  assert.match(browser, /disabled=""/); assert.match(browser, /Native setup actions are disabled/);
});
test('before sign-in reporting is unchecked and native browser actions are disabled', () => {
  const c = machine(); const account = new AccountController(null, c);
  const markup = renderToStaticMarkup(createElement(SettingsView, { machine: c.state, state: { ...account.state, hosted }, controller: account, machineController: c }));
  assert.match(markup, /type="checkbox" disabled=""/); assert.doesNotMatch(markup, /checked=""/);
  assert.match(markup, /Sign in with GitHub/); assert.match(markup, /Restart \/ reinstall agent/);
  assert.doesNotMatch(markup, /Open GitHub/);
});
test('pending sign-in shows only transient code, explicit browser action and cancel, with actual backoff', () => {
  const c = machine(); const account = new AccountController(null, c);
  const markup = renderToStaticMarkup(createElement(SettingsView, { machine: { ...c.state, connection: 'connected', status }, state: { ...account.state, flow: 'pending', code: { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }, hosted: { ...hosted, signingIn: true, retryAt: '2026-10-11T12:10:00Z', error: 'rate_limited' } }, controller: account, machineController: c }));
  assert.match(markup, /ABCD-1234/); assert.match(markup, /Open GitHub/); assert.match(markup, /Cancel sign-in/); assert.match(markup, /Retry after:.*2026-10-11T12:10:00Z/); assert.match(markup, /rate_limited/);
  assert.doesNotMatch(markup, /Sign in with GitHub/);
});
test('signed-in settings show identity, queue acknowledgement and explicit unchecked repository consent', () => {
  const c = machine(); const account = new AccountController(null, c);
  const markup = renderToStaticMarkup(createElement(SettingsView, { machine: { ...c.state, connection: 'connected', status }, state: { ...account.state, hosted: { ...hosted, auth: 'signed-in', accountId: 'account-a', login: 'fixture-login', machineId: 'machine-a', machine: { policy: 'notify', reportStatus: false }, setups: [{ setupId: 'setup-a', name: 'Offered fixture', repoUrl: 'https://example.com/fixture.git', latestRevision: 0 }], lastSyncAt: '2026-10-11T12:00:00Z' }, detail: 'Machine settings queued.' }, controller: account, machineController: c }));
  for (const label of ['Signed in as fixture-login', 'Sign out', 'Sync now / retry', 'New machine name', 'Queue name change', 'Resume automatic apply', 'https://example.com/fixture.git', 'I trust this repository', 'Machine settings queued']) assert.ok(markup.includes(label), label);
  assert.doesNotMatch(markup, /Sign in with GitHub|checked=""/);
  assert.match(markup, /button disabled="">Trust on this Mac/);
});
test('overview and resolved render only current inspection counts and provenance', () => {
  const c = machine();
  const state = { ...c.state, status, inspection: { profile: { repo: '/fixture', revision: 'fixture-revision', overrides: '/fixture/overrides', issues: [] }, items: [{ key: 'config:a', domain: 'config' as const, label: 'Fixture item', group: 'Files', state: 'repo-ahead', disposition: 'apply' as const, from: { layer: 'machine' as const, source: '/fixture/overrides' } }], probeErrors: [] } };
  const overview = renderToStaticMarkup(createElement(OverviewView, { state, navigate: () => {} }));
  assert.match(overview, /Pending.*<strong>3/); assert.match(overview, /Cancelled/); assert.match(overview, /2026-10-11T12:00:00Z/);
  const resolved = renderToStaticMarkup(createElement(ResolvedView, { state, controller: c }));
  assert.match(resolved, /Fixture item/); assert.match(resolved, /machine · \/fixture\/overrides/);
  assert.doesNotMatch(resolved, /type="checkbox"|Add override|Remove override|diff/i);
});
test('Review remains usable locally with selection, preview and external activity cancellation', () => {
  const c = machine();
  const markup = renderToStaticMarkup(createElement(ReviewView, { controller: c, state: { ...c.state, connection: 'connected', status: { ...status, applying: true } } }));
  assert.match(markup, /Review &amp; apply/); assert.match(markup, /Cancel<\/button>/); assert.doesNotMatch(markup, /disabled="">Cancel<\/button>/); assert.match(markup, /Automatic apply paused/);
});
test('new notification requests route every screen to Review without previewing or applying', () => {
  for (const screen of ['overview', 'resolved', 'settings', 'review'] as const) assert.equal(screenForReview(screen, 1, 2), 'review');
  assert.equal(screenForReview('settings', 2, 2), 'settings');
});
