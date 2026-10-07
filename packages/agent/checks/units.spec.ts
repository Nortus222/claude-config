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
  assert.ok(renderLaunchAgent('com.nortuscc.agent', { ...program, argv: ['/bin/x', `<a>'b'`] }).includes('<string>&lt;a&gt;&apos;b&apos;</string>'));
});

test('systemd Environment= keeps $ single, since it is not expanded there', () => {
  const unit = renderSystemdUnit({ ...program, env: { SECRET: 'pa$word' } });
  assert.ok(unit.includes('Environment="SECRET=pa$word"'));
});

test('systemd values with a control character are refused', () => {
  assert.throws(() => renderSystemdUnit({ ...program, argv: ['/bin/x', 'a\nExecStop=/bin/evil'] }), /control character/);
  assert.throws(() => renderSystemdUnit({ ...program, env: { K: 'a\nb' } }), /control character/);
});

test('the scheduled task launches a single program through the headless console host', () => {
  const task = renderScheduledTask({ ...program, argv: ['/bin/x'] }, 'me');
  assert.ok(task.includes('<Command>%SystemRoot%\\System32\\conhost.exe</Command>'));
  assert.ok(task.includes('<Arguments>--headless &quot;/bin/x&quot;</Arguments>'));
  assert.match(task, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>/);
});

test('the systemd unit escapes quotes, specifiers and variable expansion', () => {
  const unit = renderSystemdUnit({ ...awkward, logPath: '/tmp/100%/agent.log' });
  assert.ok(unit.includes('"a\\"b%%c$$d&e"'));
  assert.ok(unit.includes('StandardOutput=append:/tmp/100%%/agent.log'));
});

test('the scheduled task quotes arguments for Windows and escapes XML', () => {
  const xml = renderScheduledTask(awkward, 'me');
  assert.ok(xml.includes('<Arguments>--headless &quot;/opt/node/bin/node&quot; &quot;a\\&quot;b%c$d&amp;e&quot;</Arguments>'));
  assert.ok(xml.includes('<UserId>me</UserId>'));
});

test('the headless task preserves spaces, embedded quotes, trailing slashes and empty arguments', () => {
  const task = renderScheduledTask({ ...program, argv: [
    'C:\\Program Files\\node.exe', 'C:\\config & files\\nortuscc.mjs', 'a\\"b', 'C:\\trailing\\', '',
  ] }, 'me & you');
  assert.ok(task.includes('<Arguments>--headless &quot;C:\\Program Files\\node.exe&quot; &quot;C:\\config &amp; files\\nortuscc.mjs&quot; &quot;a\\\\\\&quot;b&quot; &quot;C:\\trailing\\\\&quot; &quot;&quot;</Arguments>'));
  assert.ok(task.includes('<UserId>me &amp; you</UserId>'));
});
