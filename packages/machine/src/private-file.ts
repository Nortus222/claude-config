import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { Effect, type Layer } from 'effect';
import { nodeProcesses, Processes } from './processes.ts';
import { FsFailed } from './errors.ts';

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const info = (path: string) => lstat(path).catch((error) => { if (absent(error)) return undefined; throw error; });

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

// Credentials require owner-controlled ancestors. Path checks cannot prevent a hostile ancestor replacement.
// Filesystem steps finish before interruption returns; helper processes remain in the caller's Effect scope.
export const privateFile = (path: string, options: PrivateFileOptions = {}) => {
  const platform = options.platform ?? process.platform;
  const failure = (operation: string) => new FsFailed({ op: operation, path, reason: 'private file operation failed' });
  const attempt = <A>(operation: string, run: () => Promise<A>) => Effect.tryPromise({
    try: run, catch: () => failure(operation),
  }).pipe(Effect.uninterruptible);
  const secure = (target: string, action: 'protect' | 'check') => platform !== 'win32' ? Effect.void
    : Processes.use((processes) => processes.run({
      cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsAclHelper, 'utf16le').toString('base64')],
      input: JSON.stringify({ path: target, action }), output: 'capture', stderr: 'capture',
    })).pipe(
      Effect.provide(options.processes ?? nodeProcesses()),
      Effect.mapError(() => failure('permissions')),
      Effect.flatMap((result) => result.code === 0 ? Effect.void : Effect.fail(failure('permissions'))),
    );
  const directory = dirname(path);
  const inspectDirectories = (create: boolean, requirePrivate = true) => Effect.gen(function* () {
    if (!isAbsolute(path)) return yield* Effect.fail(failure('inspect'));
    const root = parse(directory).root;
    let current = root;
    for (const part of directory.slice(root.length).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      let entry = yield* attempt('inspect', () => info(current));
      if (!entry && create) {
        yield* attempt('mkdir', () => mkdir(current, { mode: 0o700 }).catch((error) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }));
        entry = yield* attempt('inspect', () => info(current));
      }
      if (!entry) return false;
      if (!entry.isDirectory() || entry.isSymbolicLink()) return yield* Effect.fail(failure('inspect'));
    }
    if (create) {
      yield* attempt('permissions', () => chmod(directory, 0o700));
      yield* secure(directory, 'protect');
    } else if (requirePrivate && platform !== 'win32') {
      const entry = yield* attempt('inspect', () => lstat(directory));
      if ((entry.mode & 0o777) !== 0o700) return yield* Effect.fail(failure('inspect'));
    }
    if (requirePrivate) yield* secure(directory, 'check');
    return true;
  });
  const inspectFile = () => Effect.gen(function* () {
    const entry = yield* attempt('inspect', () => info(path));
    if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
      || platform !== 'win32' && (entry.mode & 0o777) !== 0o600)) return yield* Effect.fail(failure('inspect'));
    if (entry) yield* secure(path, 'check');
    return entry;
  });
  return {
    read: () => Effect.gen(function* () {
      if (! (yield* inspectDirectories(false, false)) || ! (yield* inspectFile())) return undefined;
      yield* inspectDirectories(false);
      return yield* Effect.acquireUseRelease(
        attempt('read', () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW)),
        (handle) => Effect.gen(function* () {
          const entry = yield* attempt('inspect', () => handle.stat());
          if (!entry.isFile() || entry.nlink !== 1 || platform !== 'win32' && (entry.mode & 0o777) !== 0o600) return yield* Effect.fail(failure('inspect'));
          return yield* attempt('read', () => handle.readFile('utf8'));
        }),
        (handle) => attempt('close', () => handle.close()),
      );
    }),
    write: (text: string) => Effect.gen(function* () {
      yield* inspectDirectories(true); yield* inspectFile();
      const temporary = join(directory, `.machine-token.${randomUUID()}.tmp`);
      yield* Effect.acquireUseRelease(
        attempt('write', () => open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)),
        (handle) => Effect.gen(function* () {
          yield* secure(temporary, 'protect');
          yield* attempt('write', () => handle.writeFile(text, 'utf8'));
          yield* attempt('sync', () => handle.sync());
          yield* attempt('close', () => handle.close());
          yield* inspectDirectories(false); yield* inspectFile();
          yield* attempt('write', () => rename(temporary, path));
        }),
        (handle) => Effect.gen(function* () {
          const closed = yield* Effect.exit(attempt('close', () => handle.close()));
          yield* attempt('remove', () => unlink(temporary).catch((error) => { if (!absent(error)) throw error; }));
          if (closed._tag === 'Failure') yield* Effect.failCause(closed.cause);
        }),
      );
    }),
    remove: () => Effect.gen(function* () {
      if (! (yield* inspectDirectories(false, false)) || ! (yield* inspectFile())) return;
      yield* inspectDirectories(false);
      yield* attempt('remove', () => unlink(path));
    }),
  };
};
