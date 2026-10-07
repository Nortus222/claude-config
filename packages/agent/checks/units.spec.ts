import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderLaunchAgent, renderScheduledTask, renderSystemdUnit, type ServiceProgram } from '../src/index.ts';

const program: ServiceProgram = {
  argv: ['/opt/node/bin/node', '/Users/me/claude config/bin/nortuscc.mjs', 'agent', 'run'],
  env: { PATH: '/usr/bin:/bin', NORTUSCC_STATE_DIR: '/Users/me/.config/nortuscc' },
  workingDirectory: '/Users/me/claude config',
  logPath: '/Users/me/.config/nortuscc/agent/agent.log',
};
const awkward: ServiceProgram = { ...program, argv: ['/opt/node/bin/node', 'a"b%c$d&e'] };

const matches = (name: string, actual: string) => {
  const file = new URL(`./snapshots/${name}`, import.meta.url);
  if (process.env.UPDATE_SNAPSHOTS === '1') writeFileSync(file, actual);
  assert.equal(actual, readFileSync(file, 'utf8'));
};

test('the LaunchAgent plist matches its snapshot', () => matches('launch-agent.plist', renderLaunchAgent('com.nortuscc.agent', program)));
test('the systemd unit matches its snapshot', () => matches('nortuscc-agent.service', renderSystemdUnit(program)));
test('the scheduled task matches its snapshot', () => matches('nortuscc-agent.xml', renderScheduledTask(program, 'me')));

test('the plist XML-escapes values', () => {
  assert.ok(renderLaunchAgent('com.nortuscc.agent', awkward).includes('<string>a&quot;b%c$d&amp;e</string>'));
});

test('the systemd unit escapes quotes, specifiers and variable expansion', () => {
  const unit = renderSystemdUnit({ ...awkward, logPath: '/tmp/100%/agent.log' });
  assert.ok(unit.includes('"a\\"b%%c$$d&e"'));
  assert.ok(unit.includes('StandardOutput=append:/tmp/100%%/agent.log'));
});

test('the scheduled task quotes arguments for Windows and escapes XML', () => {
  const xml = renderScheduledTask(awkward, 'me');
  assert.ok(xml.includes('<Arguments>&quot;a\\&quot;b%c$d&amp;e&quot;</Arguments>'));
  assert.ok(xml.includes('<UserId>me</UserId>'));
});
