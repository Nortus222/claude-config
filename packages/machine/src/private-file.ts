import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { Effect, type Layer } from 'effect';
import { nodeProcesses, Processes } from './processes.ts';
import { FsFailed } from './errors.ts';

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const info = (path: string) => lstat(path).catch((error) => { if (absent(error)) return undefined; throw error; });
const refuse = () => { throw new Error('unsafe private file'); };

// Fixed ACL helper uses stdin for the path and action, never for file contents.
const windowsAclHelper = `
$ErrorActionPreference = 'Stop'
try {
  $inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $target = [IO.Path]::GetFullPath($inputValue.path)
  $ancestor = $target
  while ($ancestor) {
    $entry = Get-Item -LiteralPath $ancestor -Force
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
  }
  $entry = Get-Item -LiteralPath $target -Force
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($inputValue.action -eq 'protect') {
    $acl = if ($entry.PSIsContainer) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = if ($entry.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $target -AclObject $acl
  } elseif ($inputValue.action -ne 'check') { exit 1 }
  $acl = Get-Acl -LiteralPath $target
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1) { exit 1 }
  $rule = $rules[0]
  if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.IsInherited -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { exit 1 }
  exit 0
} catch { exit 1 }
`;

export type PrivateFileOptions = { readonly platform?: NodeJS.Platform; readonly processes?: Layer.Layer<Processes> };

// Credentials use this boundary instead of Fs, whose normal writes intentionally follow links.
export const privateFile = (path: string, options: PrivateFileOptions = {}) => {
  const platform = options.platform ?? process.platform;
  const secure = async (target: string, action: 'protect' | 'check') => {
    if (platform !== 'win32') return;
    const result = await Effect.runPromise(Processes.use((processes) => processes.run({
      cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsAclHelper, 'utf16le').toString('base64')],
      input: JSON.stringify({ path: target, action }), output: 'capture', stderr: 'capture',
    })).pipe(Effect.provide(options.processes ?? nodeProcesses())));
    if (result.code !== 0) refuse();
  };
  const directory = dirname(path);
  const inspectDirectories = async (create: boolean, requirePrivate = true) => {
    if (!isAbsolute(path)) refuse();
    const root = parse(directory).root;
    let current = root;
    for (const part of directory.slice(root.length).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      let entry = await info(current);
      if (!entry && create) { await mkdir(current, { mode: 0o700 }).catch((error) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }); entry = await info(current); }
      if (!entry) return false;
      if (!entry.isDirectory() || entry.isSymbolicLink()) refuse();
    }
    if (create) { await chmod(directory, 0o700); await secure(directory, 'protect'); }
    else if (requirePrivate && platform !== 'win32' && ((await lstat(directory)).mode & 0o777) !== 0o700) refuse();
    if (requirePrivate) await secure(directory, 'check');
    return true;
  };
  const inspectFile = async () => {
    const entry = await info(path);
    if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
      || platform !== 'win32' && (entry.mode & 0o777) !== 0o600)) refuse();
    if (entry) await secure(path, 'check');
    return entry;
  };
  const attempt = <A>(operation: string, run: () => Promise<A>) => Effect.tryPromise({
    try: run, catch: () => new FsFailed({ op: operation, path, reason: 'private file operation failed' }),
  });
  return {
    read: () => attempt('read', async () => {
      if (!await inspectDirectories(false, false) || !await inspectFile()) return undefined;
      await inspectDirectories(false);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const entry = await handle.stat();
        if (!entry.isFile() || entry.nlink !== 1 || platform !== 'win32' && (entry.mode & 0o777) !== 0o600) refuse();
        return await handle.readFile('utf8');
      } finally { await handle.close(); }
    }),
    write: (text: string) => attempt('write', async () => {
      await inspectDirectories(true); await inspectFile();
      const temporary = join(directory, `.machine-token.${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await secure(temporary, 'protect'); await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        await inspectDirectories(false); await inspectFile();
        await rename(temporary, path);
      } finally { await unlink(temporary).catch((error) => { if (!absent(error)) throw error; }); }
    }),
    remove: () => attempt('remove', async () => {
      if (!await inspectDirectories(false, false) || !await inspectFile()) return;
      await inspectDirectories(false);
      await unlink(path);
    }),
  };
};
