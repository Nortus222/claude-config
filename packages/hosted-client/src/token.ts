import { Context, Effect, Layer } from 'effect';
import { join } from 'node:path';
import { nodeProcesses, privateFile, Processes, type Command, type MachinePathsValue } from '@nortuscc/machine';
import { HostedFailure } from './transport.ts';

export type TokenKeychain = {
  readonly read: () => Effect.Effect<string | undefined, HostedFailure>;
  readonly write: (token: string) => Effect.Effect<void, HostedFailure>;
  readonly remove: () => Effect.Effect<void, HostedFailure>;
};
export class MachineTokenStore extends Context.Service<MachineTokenStore, TokenKeychain>()('hosted-client/MachineTokenStore') {}

const unavailable = () => new HostedFailure({ code: 'keychain_unavailable' });
const storageFailure = () => new HostedFailure({ code: 'credential_storage' });
const service = 'nortuscc';
const account = 'machine-token';

// Fixed Credential Manager helper reads the token from stdin. Captured diagnostics stay inside the adapter.
const windowsHelper = (operation: 'read' | 'write' | 'remove') => `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NortusCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount;
    public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Write(ref Credential credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Read(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Delete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);
}
'@
$target = 'nortuscc/machine-token'
${operation === 'write' ? `
$bytes = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
$pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
  $credential = New-Object NortusCredential+Credential
  $credential.Type = 1; $credential.TargetName = $target; $credential.UserName = 'machine-token'
  $credential.CredentialBlobSize = $bytes.Length; $credential.CredentialBlob = $pointer; $credential.Persist = 2
  if (-not [NortusCredential]::Write([ref]$credential, 0)) { exit 1 }
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer) }
` : operation === 'read' ? `
$pointer = [IntPtr]::Zero
if (-not [NortusCredential]::Read($target, 1, 0, [ref]$pointer)) {
  if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 44 }; exit 1
}
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][NortusCredential+Credential])
  $bytes = New-Object byte[] $credential.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
} finally { [NortusCredential]::CredFree($pointer) }
` : `
if (-not [NortusCredential]::Delete($target, 1, 0)) {
  if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { exit 1 }
}
`}
`;

const nativeKeychain = (platform: NodeJS.Platform, processes: Layer.Layer<Processes>): TokenKeychain => {
  const run = (command: Command) => Processes.use((p) => p.run(command)).pipe(
    Effect.provide(processes), Effect.mapError(unavailable),
  );
  const command = (operation: 'read' | 'write' | 'remove', token?: string): Command | undefined => {
    const output = { output: 'capture', stderr: 'capture' } as const;
    if (platform === 'darwin') {
      if (operation === 'write') {
        // security -i parses commands from stdin; quoting prevents a token from becoming a command.
        const quoted = token!.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return { cmd: 'security', args: ['-i'], input: `add-generic-password -U -s ${service} -a ${account} -w "${quoted}"\n`, ...output };
      }
      return { cmd: 'security', args: [operation === 'read' ? 'find-generic-password' : 'delete-generic-password', '-s', service, '-a', account, ...(operation === 'read' ? ['-w'] : [])], ...output };
    }
    if (platform === 'linux') return { cmd: 'secret-tool', args: operation === 'write'
      ? ['store', '--label=nortuscc machine token', 'service', service, 'account', account]
      : [operation === 'read' ? 'lookup' : 'clear', 'service', service, 'account', account], ...(operation === 'write' ? { input: token } : {}), ...output };
    if (platform === 'win32') return { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsHelper(operation)], ...(operation === 'write' ? { input: token } : {}), ...output };
    return undefined;
  };
  const execute = (operation: 'read' | 'write' | 'remove', token?: string) => Effect.gen(function* () {
    const cmd = command(operation, token);
    if (!cmd) return yield* Effect.fail(unavailable());
    const completed = yield* run(cmd);
    const absent = completed.code === 44 && platform !== 'linux' || completed.code === 1 && platform === 'linux' && completed.stderr === '';
    if (completed.code !== 0 && !(operation !== 'write' && absent)) {
      return yield* Effect.fail(operation === 'remove' && completed.code !== 127 ? storageFailure() : unavailable());
    }
    return operation === 'read' && completed.code === 0 ? completed.stdout.replace(/[\r\n]+$/, '') || undefined : undefined;
  });
  return { read: () => execute('read'), write: (token) => execute('write', token).pipe(Effect.asVoid), remove: () => execute('remove').pipe(Effect.asVoid) };
};

export type MachineTokenStoreOptions = {
  readonly platform: NodeJS.Platform;
  readonly processes?: Layer.Layer<Processes>;
  readonly keychain?: TokenKeychain;
};

// A fallback is authoritative until a successful native write removes it, so stale native values cannot resurface.
export const machineTokenStore = (paths: MachinePathsValue, options: MachineTokenStoreOptions) => {
  const file = privateFile(join(paths.stateRoot, 'agent', 'machine-token'), { platform: options.platform, processes: options.processes });
  const keychain = options.keychain ?? nativeKeychain(options.platform, options.processes ?? nodeProcesses());
  const fallbackRead = () => file.read().pipe(Effect.mapError(storageFailure));
  const fallbackRemove = () => file.remove().pipe(Effect.mapError(storageFailure));
  const tolerateUnavailable = <A>(effect: Effect.Effect<A, HostedFailure>, fallback: () => Effect.Effect<A, HostedFailure>) =>
    effect.pipe(Effect.catch((error) => error.code === 'keychain_unavailable' ? fallback() : Effect.fail(storageFailure())));
  return Layer.succeed(MachineTokenStore, {
    read: () => Effect.gen(function* () {
      const token = yield* fallbackRead();
      if (token !== undefined) return token;
      return yield* tolerateUnavailable(keychain.read(), () => Effect.succeed(undefined));
    }),
    write: (token) => Effect.gen(function* () {
      if (!token || /[\r\n\0]/.test(token)) return yield* Effect.fail(storageFailure());
      // Refuse unsafe fallback paths even when the native keychain is available.
      yield* fallbackRead();
      const stored = yield* tolerateUnavailable(keychain.write(token).pipe(Effect.as(true)), () => Effect.succeed(false));
      if (stored) yield* fallbackRemove();
      else yield* file.write(token).pipe(Effect.mapError(storageFailure));
    }),
    remove: () => Effect.gen(function* () {
      yield* fallbackRead();
      yield* tolerateUnavailable(keychain.remove(), () => Effect.void);
      yield* fallbackRemove();
    }),
  });
};
