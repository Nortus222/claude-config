import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OperationOutput } from '@nortuscc/agent/operations';
import { MachineController } from '../src/controller.ts';
import { MachinesController, revisionError, type Column, type MachinesViewState } from '../src/machines-controller.ts';
import { InstallDialog, MachinesView } from '../src/machines-view.tsx';
import { ShellView } from '../src/views.tsx';
import { status } from './support/skills-data.ts';

type Skill = OperationOutput<'machineSkills'>['skills'][number];
const skill = (name: string, fields: Partial<Skill> = {}): Skill => ({ source: 'owner/skills', name, state: 'installed', choice: null, from: null, ...fields });
const recently = new Date(Date.now() - 3 * 60_000).toISOString();
const column = (ref: string, name: string, fields: Partial<Column> = {}): Column => ({ ref, name, os: 'macOS', self: false, reach: 'ok', lastReachedAt: recently,
  inspectedAt: recently, skills: [], loading: false, error: null, ...fields });
const key = (source: string | null, name: string) => JSON.stringify([source, name]);
const render = (fields: Partial<MachinesViewState> = {}) => {
  const machine = new MachineController(null), controller = new MachinesController(null, machine);
  const state: MachinesViewState = { ...controller.state, native: true,
    access: { enabled: true, tailscale: 'ready', self: { name: 'mac', login: 'me@example.com' }, listening: true }, ...fields };
  return renderToStaticMarkup(createElement(MachinesView, { state, machine: { ...machine.state, connection: 'connected', initialReadPending: false, status: status() }, controller }));
};

test('the nav opens Skills on my machines under MY MACHINES', () => {
  const machine = new MachineController(null), controller = new MachinesController(null, machine);
  const html = renderToStaticMarkup(createElement(ShellView, { screen: 'machines', navigate: () => {}, children: createElement(MachinesView, { state: controller.state, machine: machine.state, controller }) }));
  assert.match(html, />MY MACHINES</); assert.match(html, /aria-current="page">Skills on my machines/);
  assert.match(html, /Open the desktop app/);
});
test('headers name each machine with its OS and when it was checked, and every cell kind reads in words', () => {
  const html = render({
    columns: [
      column('this', 'mac', { self: true, skills: [skill('installed-one'), skill('absent-one', { state: 'absent' }), skill('outside', { state: 'undeclared' }),
        skill('by-profile', { state: 'profile-off' }), skill('busy', { state: 'absent' }), skill('broken', { state: 'absent' })] }),
      column('n-pc', 'pc', { os: 'windows', skills: [skill('installed-one', { state: 'absent' })] }),
    ],
    changes: { this: { [key('owner/skills', 'busy')]: 'working', [key('owner/skills', 'broken')]: { failed: 'Install failed. EBUSY.' } } },
  });
  assert.match(html, /mac/); assert.match(html, /macOS/); assert.match(html, /pc/); assert.match(html, /windows/); assert.match(html, /checked 3 minutes ago/);
  for (const words of ['Installed', 'Not installed', 'Installed outside the app', 'Off by profile', 'Working…', 'Install failed. EBUSY.']) assert.match(html, new RegExp(words));
  assert.match(html, /aria-label="Remove installed-one from mac"/); assert.match(html, /aria-label="Install installed-one on pc"/);
  assert.match(html, /Installed outside the app; remove it on mac\./);
  assert.doesNotMatch(html, />[^<]*(?:\d{4}-\d{2}-\d{2}T|profile-off|undeclared|n-pc)[^<]*</, 'no raw states, node IDs or ISO times are shown');
});
test('an unreachable column shows its reason and offers no actions', () => {
  for (const [reach, words] of [['offline', /old is offline\. Last reached/], ['app-closed', /The app is closed on old\./], ['remote-off', /Remote access is off on old\. Turn it on in the app on that machine\./],
    ['incompatible', /Update the app on old\./]] as const) {
    const html = render({ columns: [column('n-old', 'old', { reach, skills: null })] });
    assert.match(html, words); assert.doesNotMatch(html, /<td[^>]*>(?:(?!<\/td>).)*<button/);
  }
});
test('a hand-installed skill with no known source cannot be copied, and says why', () => {
  const html = render({ columns: [column('this', 'mac', { self: true, skills: [skill('handmade', { source: null, state: 'undeclared' })] }), column('n-pc', 'pc')] });
  assert.match(html, /installed outside the app/); assert.match(html, /The app doesn’t know where this skill came from\./);
});
test('the connect section walks through Tailscale until remote access is on here', () => {
  const admin = render({ access: { enabled: false, tailscale: 'needs-admin', self: null, listening: false } });
  assert.match(admin, /Connect my machines/); assert.match(admin, /Tailscale needs an administrator account on this Mac to confirm who is calling\./);
  assert.match(admin, /Turn on remote access/);
  const loggedOut = render({ access: { enabled: false, tailscale: 'logged-out', self: null, listening: false } });
  assert.match(loggedOut, /Tailscale isn’t signed in on this Mac, or is waiting for your tailnet admin to approve it\./);
  const signedIn = render({ access: { enabled: false, tailscale: 'ready', self: { name: 'mac', login: 'me@example.com' }, listening: false } });
  assert.match(signedIn, /me@example\.com/); assert.match(signedIn, /Remote access is off/);
  assert.doesNotMatch(render(), /Connect my machines/);
});
test('the install dialog offers each online machine and all of them', () => {
  const machine = new MachineController(null), controller = new MachinesController(null, machine);
  const state: MachinesViewState = { ...controller.state, native: true, columns: [column('this', 'mac', { self: true }), column('n-pc', 'pc'), column('n-old', 'old', { reach: 'offline', skills: null })] };
  const html = renderToStaticMarkup(createElement(MachinesView, { state, machine: { ...machine.state, connection: 'connected', initialReadPending: false, status: status() }, controller, installing: true }));
  assert.match(html, /Source/); assert.match(html, /Skill name/); assert.match(html, /All online machines/);
  assert.match(html, /type="checkbox"[^>]*\/?>(?:<span>)?mac/); assert.match(html, /type="checkbox"[^>]*\/?>(?:<span>)?pc/); assert.doesNotMatch(html, /type="checkbox"[^>]*\/?>(?:<span>)?old/);
});

test('the install dialog takes an optional revision and explains a malformed one in words', () => {
  assert.equal(revisionError(''), null); assert.equal(revisionError('0123456789abcdef0123456789abcdef01234567'), null);
  assert.match(revisionError('main')!, /full commit ID: 40 characters/);
  const machine = new MachineController(null), controller = new MachinesController(null, machine), columns = [column('this', 'mac', { self: true })];
  const empty = renderToStaticMarkup(createElement(InstallDialog, { columns, disabled: false, controller, onClose: () => {} }));
  assert.match(empty, /Revision \(optional\)/); assert.doesNotMatch(empty, /role="alert"/);
  const bad = renderToStaticMarkup(createElement(InstallDialog, { columns, disabled: false, controller, onClose: () => {}, initial: { revision: 'main' } }));
  assert.match(bad, /aria-invalid="true"/); assert.match(bad, /role="alert">A revision is a full commit ID/);
});
