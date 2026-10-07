import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Fiber, Layer } from 'effect';
import { Processes, type Command, type MachinePathsValue } from '@nortuscc/machine';
import { HostedFailure, MachineTokenStore, machineTokenStore } from '../src/index.ts';

const temp = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-token-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths: MachinePathsValue = { repo: root, claude: join(root, '.claude'), codex: join(root, '.codex'), codexOpenRouter: join(root, '.codex-openrouter'), agentsSkills: join(root, 'skills'), stateRoot: join(root, 'state'), backups: join(root, 'backups') };
  return { root, paths, file: join(paths.stateRoot, 'agent', 'machine-token') };
};
const failure = (error: unknown) => error instanceof HostedFailure && error.code === 'credential_storage'
  && !JSON.stringify(error).includes('private-token') && !String(error).includes('private-token');

for (const platform of ['darwin', 'linux', 'win32'] as const) {
  test(`${platform} native credential writes use stdin and capture diagnostics`, async (t) => {
    const m = await temp(t);
    const commands: Command[] = [];
    const processes = Layer.succeed(Processes, { run: (command) => { commands.push(command); return Effect.succeed({ code: 0, stdout: '', stderr: 'private-token' }); } });
    await Effect.runPromise(MachineTokenStore.use((store) => store.write('private-token')).pipe(Effect.provide(machineTokenStore(m.paths, { platform, processes }))));
    assert.ok(commands.length > 0);
    assert.ok(commands.some((command) => command.input?.includes('private-token')));
    for (const command of commands) {
      assert.ok(!command.args.join(' ').includes('private-token'));
      assert.equal(command.output, 'capture');
      assert.equal(command.stderr, 'capture');
    }
    await assert.rejects(lstat(m.file), { code: 'ENOENT' });
  });
}
test('injected keychain reads and removes an opaque token', async (t) => {
  const m = await temp(t);
  let token: string | undefined;
  const layer = machineTokenStore(m.paths, { platform: 'linux', keychain: {
    read: () => Effect.succeed(token), write: (value) => Effect.sync(() => { token = value; }), remove: () => Effect.sync(() => { token = undefined; }),
  } });
  await Effect.runPromise(MachineTokenStore.use((store) => Effect.gen(function* () {
    assert.equal(yield* store.read(), undefined);
    yield* store.write('opaque-token');
    assert.equal(yield* store.read(), 'opaque-token');
    yield* store.remove();
    assert.equal(yield* store.read(), undefined);
  })).pipe(Effect.provide(layer)));
});
test('unsupported platform fallback is atomic, private, replaceable and removable', async (t) => {
  const m = await temp(t);
  const layer = machineTokenStore(m.paths, { platform: 'freebsd' });
  await Effect.runPromise(MachineTokenStore.use((store) => Effect.gen(function* () {
    assert.equal(yield* store.read(), undefined);
    yield* store.write('first-token');
    yield* store.write('private-token');
    assert.equal(yield* store.read(), 'private-token');
  })).pipe(Effect.provide(layer)));
  assert.equal((await lstat(m.file)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(m.paths.stateRoot, 'agent'))).mode & 0o777, 0o700);
  assert.equal(await readFile(m.file, 'utf8'), 'private-token');
  await Effect.runPromise(MachineTokenStore.use((store) => store.remove()).pipe(Effect.provide(layer)));
  assert.equal(await Effect.runPromise(MachineTokenStore.use((store) => store.read()).pipe(Effect.provide(layer))), undefined);
});
test('unavailable native keychain uses private fallback without leaking diagnostics', async (t) => {
  const m = await temp(t);
  const processes = Layer.succeed(Processes, { run: () => Effect.succeed({ code: 127, stdout: 'private-token', stderr: 'private-token' }) });
  const layer = machineTokenStore(m.paths, { platform: 'linux', processes });
  await Effect.runPromise(MachineTokenStore.use((store) => store.write('private-token')).pipe(Effect.provide(layer)));
  assert.equal(await Effect.runPromise(MachineTokenStore.use((store) => store.read()).pipe(Effect.provide(layer))), 'private-token');
});
for (const target of ['file', 'directory', 'stateRoot']) {
  test(`fallback refuses a symlink at ${target} for read/write/remove`, async (t) => {
    const m = await temp(t);
    const victim = join(m.root, 'victim');
    await mkdir(victim); await writeFile(join(victim, 'machine-token'), 'do-not-touch');
    await mkdir(join(m.paths.stateRoot, 'agent'), { recursive: true });
    const link = target === 'file' ? m.file : target === 'directory' ? join(m.paths.stateRoot, 'agent') : m.paths.stateRoot;
    if (target !== 'file') await rm(link, { recursive: true });
    await symlink(target === 'file' ? join(victim, 'machine-token') : victim, link);
    const layer = machineTokenStore(m.paths, { platform: 'freebsd' });
    for (const action of ['read', 'write', 'remove'] as const) {
      await assert.rejects(Effect.runPromise(MachineTokenStore.use((store) => action === 'write' ? store.write('private-token') : store[action]()).pipe(Effect.provide(layer))), failure);
    }
    assert.equal(await readFile(join(victim, 'machine-token'), 'utf8'), 'do-not-touch');
  });
}
test('fallback refuses an existing token file with public permissions', async (t) => {
  const m = await temp(t);
  await mkdir(join(m.paths.stateRoot, 'agent'), { recursive: true, mode: 0o700 });
  await writeFile(m.file, 'private-token'); await chmod(m.file, 0o644);
  await assert.rejects(Effect.runPromise(MachineTokenStore.use((store) => store.read()).pipe(Effect.provide(machineTokenStore(m.paths, { platform: 'freebsd' })))), failure);
});

test('fallback written during an outage wins over a stale native token until a successful native write', async (t) => {
  const m = await temp(t);
  let available = false;
  let native = 'stale-token';
  let removed = false;
  const layer = machineTokenStore(m.paths, { platform: 'linux', keychain: {
    read: () => Effect.succeed(native),
    write: (value) => available ? Effect.sync(() => { native = value; }) : Effect.fail(new HostedFailure({ code: 'keychain_unavailable' })),
    remove: () => Effect.sync(() => { native = ''; removed = true; }),
  } });
  await Effect.runPromise(MachineTokenStore.use((store) => store.write('fresh-fallback')).pipe(Effect.provide(layer)));
  available = true;
  assert.equal(await Effect.runPromise(MachineTokenStore.use((store) => store.read()).pipe(Effect.provide(layer))), 'fresh-fallback');
  await Effect.runPromise(MachineTokenStore.use((store) => store.write('fresh-native')).pipe(Effect.provide(layer)));
  await assert.rejects(lstat(m.file), { code: 'ENOENT' });
  assert.equal(await Effect.runPromise(MachineTokenStore.use((store) => store.read()).pipe(Effect.provide(layer))), 'fresh-native');
  available = false;
  await Effect.runPromise(MachineTokenStore.use((store) => store.write('another-fallback')).pipe(Effect.provide(layer)));
  await Effect.runPromise(MachineTokenStore.use((store) => store.remove()).pipe(Effect.provide(layer)));
  assert.equal(removed, true);
  await assert.rejects(lstat(m.file), { code: 'ENOENT' });
});
test('native deletion failure is generic and leaves the fallback available for retry', async (t) => {
  const m = await temp(t);
  const fallback = machineTokenStore(m.paths, { platform: 'freebsd' });
  await Effect.runPromise(MachineTokenStore.use((store) => store.write('private-token')).pipe(Effect.provide(fallback)));
  const processes = Layer.succeed(Processes, { run: () => Effect.succeed({ code: 2, stdout: 'private-token', stderr: 'private-token' }) });
  await assert.rejects(Effect.runPromise(MachineTokenStore.use((store) => store.remove()).pipe(Effect.provide(machineTokenStore(m.paths, { platform: 'darwin', processes })))), failure);
  assert.equal(await readFile(m.file, 'utf8'), 'private-token');
});

test('Windows fallback protects directory and staging ACLs and verifies them on read using a fake helper', async (t) => {
  const m = await temp(t);
  const commands: Command[] = [];
  const processes = Layer.succeed(Processes, { run: (command) => {
    commands.push(command);
    return Effect.succeed(command.cmd === 'powershell.exe' && command.args.includes('-EncodedCommand')
      ? { code: 0, stdout: '', stderr: '' } : { code: 127, stdout: '', stderr: '' });
  } });
  const layer = machineTokenStore(m.paths, { platform: 'win32', processes });
  await Effect.runPromise(MachineTokenStore.use((store) => store.write('private-token')).pipe(Effect.provide(layer)));
  assert.equal(await Effect.runPromise(MachineTokenStore.use((store) => store.read()).pipe(Effect.provide(layer))), 'private-token');
  const operations = commands.filter((command) => command.args.includes('-EncodedCommand')).map((command) => JSON.parse(command.input!));
  assert.ok(operations.some((operation) => operation.action === 'protect' && operation.path === join(m.paths.stateRoot, 'agent')));
  assert.ok(operations.some((operation) => operation.action === 'protect' && operation.path.endsWith('.tmp')));
  assert.ok(operations.some((operation) => operation.action === 'check' && operation.path === m.file));
});
test('Windows fallback fails closed when its private ACL helper is unavailable', async (t) => {
  const m = await temp(t);
  const processes = Layer.succeed(Processes, { run: () => Effect.succeed({ code: 127, stdout: 'private-token', stderr: 'private-token' }) });
  await assert.rejects(Effect.runPromise(MachineTokenStore.use((store) => store.write('private-token')).pipe(Effect.provide(machineTokenStore(m.paths, { platform: 'win32', processes })))), failure);
  await assert.rejects(lstat(m.file), { code: 'ENOENT' });
});

test('an existing ordinary agent directory without a fallback does not block native keychain access', async (t) => {
  const m = await temp(t);
  await mkdir(join(m.paths.stateRoot, 'agent'), { recursive: true });
  await chmod(join(m.paths.stateRoot, 'agent'), 0o755);
  let value: string | undefined;
  const layer = machineTokenStore(m.paths, { platform: 'linux', keychain: {
    read: () => Effect.succeed(value), write: (token) => Effect.sync(() => { value = token; }), remove: () => Effect.sync(() => { value = undefined; }),
  } });
  await Effect.runPromise(MachineTokenStore.use((store) => store.write('private-token')).pipe(Effect.provide(layer)));
  assert.equal(await Effect.runPromise(MachineTokenStore.use((store) => store.read()).pipe(Effect.provide(layer))), 'private-token');
});

for (const fallback of [false, true]) {
  test(`unavailable native deletion suppresses recovered credentials across restart, fallback=${fallback}`, async (t) => {
    const m = await temp(t);
    let available = true;
    let native: string | undefined = 'old-native-token';
    const keychain = {
      read: () => Effect.succeed(native),
      write: (token: string) => available ? Effect.sync(() => { native = token; }) : Effect.fail(new HostedFailure({ code: 'keychain_unavailable' })),
      remove: () => available ? Effect.sync(() => { native = undefined; }) : Effect.fail(new HostedFailure({ code: 'keychain_unavailable' })),
    };
    const layer = machineTokenStore(m.paths, { platform: 'linux', keychain });
    available = false;
    if (fallback) await Effect.runPromise(MachineTokenStore.use((store) => store.write('new-fallback-token')).pipe(Effect.provide(layer)));
    await Effect.runPromise(MachineTokenStore.use((store) => store.remove()).pipe(Effect.provide(layer)));
    available = true;
    const restarted = machineTokenStore(m.paths, { platform: 'linux', keychain });
    assert.equal(await Effect.runPromise(MachineTokenStore.use((store) => store.read()).pipe(Effect.provide(restarted))), undefined);
    assert.equal(await readFile(m.file, 'utf8'), '');
    await Effect.runPromise(MachineTokenStore.use((store) => store.write('new-native-token')).pipe(Effect.provide(restarted)));
    assert.equal(await Effect.runPromise(MachineTokenStore.use((store) => store.read()).pipe(Effect.provide(restarted))), 'new-native-token');
    await assert.rejects(lstat(m.file), { code: 'ENOENT' });
    available = false;
    await Effect.runPromise(MachineTokenStore.use((store) => store.remove()).pipe(Effect.provide(restarted)));
    await Effect.runPromise(MachineTokenStore.use((store) => store.write('new-outage-token')).pipe(Effect.provide(restarted)));
    available = true;
    const again = machineTokenStore(m.paths, { platform: 'linux', keychain });
    assert.equal(await Effect.runPromise(MachineTokenStore.use((store) => store.read()).pipe(Effect.provide(again))), 'new-outage-token');
  });
}

test('interrupted Windows fallback cancels its blocked helper and cannot later restore a signed-out token', async (t) => {
  const m = await temp(t);
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  let release!: () => void;
  let cancelled = false;
  const processes = Layer.succeed(Processes, { run: (command) => {
    const operation = JSON.parse(command.input!);
    if (operation.action === 'protect' && operation.path.endsWith('.tmp')) {
      return Effect.callback((resume) => {
        release = () => resume(Effect.succeed({ code: 0, stdout: '', stderr: '' }));
        ready();
        return Effect.sync(() => { cancelled = true; });
      });
    }
    return Effect.succeed({ code: 0, stdout: '', stderr: '' });
  } });
  const keychain = { read: () => Effect.succeed(undefined), write: () => Effect.fail(new HostedFailure({ code: 'keychain_unavailable' })), remove: () => Effect.void };
  const layer = machineTokenStore(m.paths, { platform: 'win32', processes, keychain });
  const fiber = Effect.runFork(MachineTokenStore.use((store) => store.write('private-token')).pipe(Effect.provide(layer)));
  await started;
  await Effect.runPromise(Fiber.interrupt(fiber));
  await Effect.runPromise(MachineTokenStore.use((store) => store.remove()).pipe(Effect.provide(layer)));
  release();
  assert.equal(cancelled, true);
  await assert.rejects(lstat(m.file), { code: 'ENOENT' });
});
