// What a unit runs: an absolute program and its arguments (argv, never a shell line), the
// environment it needs, its working directory, and where its output goes.
export type ServiceProgram = {
  readonly argv: ReadonlyArray<string>; // argv[0] is an absolute path
  readonly env: Readonly<Record<string, string>>; // rendered in sorted key order
  readonly workingDirectory: string;
  readonly logPath: string;
};

export const LAUNCH_AGENT_LABEL = 'com.nortuscc.agent';
export const SYSTEMD_UNIT = 'nortuscc-agent.service';
export const SCHEDULED_TASK = 'nortuscc-agent';

const xml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

const sortedEnv = (program: ServiceProgram) => Object.entries(program.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** A launchd plist that starts at login and restarts the agent after any non-zero exit. */
export const renderLaunchAgent = (label: string, program: ServiceProgram): string => [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  '<dict>',
  '  <key>Label</key>',
  `  <string>${xml(label)}</string>`,
  '  <key>ProgramArguments</key>',
  '  <array>',
  ...program.argv.map((arg) => `    <string>${xml(arg)}</string>`),
  '  </array>',
  '  <key>EnvironmentVariables</key>',
  '  <dict>',
  ...sortedEnv(program).flatMap(([key, value]) => [`    <key>${xml(key)}</key>`, `    <string>${xml(value)}</string>`]),
  '  </dict>',
  '  <key>WorkingDirectory</key>',
  `  <string>${xml(program.workingDirectory)}</string>`,
  '  <key>RunAtLoad</key>',
  '  <true/>',
  '  <key>KeepAlive</key>',
  '  <dict>',
  '    <key>SuccessfulExit</key>',
  '    <false/>',
  '  </dict>',
  '  <key>ProcessType</key>',
  '  <string>Background</string>',
  '  <key>StandardOutPath</key>',
  `  <string>${xml(program.logPath)}</string>`,
  '  <key>StandardErrorPath</key>',
  `  <string>${xml(program.logPath)}</string>`,
  '</dict>',
  '</plist>',
  '',
].join('\n');

// systemd values live on one line, so a control character (newline included) is refused.
const line = (text: string) => {
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error(`a systemd unit value cannot contain a control character: ${JSON.stringify(text)}`);
  return text;
};
// Inside a systemd double-quoted word `\` and `"` are escaped and `%` starts a specifier, so it is doubled.
const quotedWord = (text: string) => `"${line(text).replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`;
// ExecStart= also expands `$VAR`, so `$` is doubled there; Environment= does not expand it.
const execWord = (text: string) => quotedWord(text).replace(/\$/g, '$$$$');
const specifiers = (text: string) => line(text).replace(/%/g, '%%');

/** A systemd user unit that runs the argv directly (no shell) and restarts it on failure. */
export const renderSystemdUnit = (program: ServiceProgram): string => [
  '[Unit]',
  'Description=nortuscc agent',
  '',
  '[Service]',
  'Type=simple',
  `ExecStart=${program.argv.map(execWord).join(' ')}`,
  ...sortedEnv(program).map(([key, value]) => `Environment=${quotedWord(`${key}=${value}`)}`),
  `WorkingDirectory=${specifiers(program.workingDirectory)}`,
  'Restart=on-failure',
  'RestartSec=10',
  `StandardOutput=append:${specifiers(program.logPath)}`,
  `StandardError=append:${specifiers(program.logPath)}`,
  '',
  '[Install]',
  'WantedBy=default.target',
  '',
].join('\n');

// Windows argv quoting, as in `batchArgument` of @nortuscc/machine but without the cmd.exe caret layer.
const windowsArgument = (arg: string) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;

/**
 * Task Scheduler XML for a headless per-user logon task. Task XML has no environment block, so
 * `program.env` is ignored on Windows. The declared UTF-16 encoding is for the caller, which
 * must write these bytes as UTF-16 for `schtasks /Create /XML`.
 */
export const renderScheduledTask = (program: ServiceProgram, user: string): string => {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${xml(user)}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xml(user)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>3</Count>',
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>%SystemRoot%\\System32\\conhost.exe</Command>',
    `      <Arguments>--headless ${xml(program.argv.map(windowsArgument).join(' '))}</Arguments>`,
    `      <WorkingDirectory>${xml(program.workingDirectory)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n');
};
