import test from 'node:test';
import assert from 'node:assert/strict';
import { removeOwnedImageContainer, withOwnedImageContainer, type DockerTransport } from './support/image.ts';

for (const reason of ['start failed after creation', 'Docker client timed out']) {
  test(`owned image cleanup removes the named daemon container when ${reason}`, async () => {
    const calls: string[][] = [];
    const failure = new Error(reason);
    const docker: DockerTransport = async (...args) => {
      calls.push(args);
      if (args[0] === 'run') throw failure;
      return '';
    };
    await assert.rejects(withOwnedImageContainer(docker, name => docker('run', '--name', name, 'fixture')), error => error === failure);
    assert.equal(calls.length, 2);
    assert.match(calls[0]![2]!, /^nortuscc-image-[a-f0-9-]+$/);
    assert.deepEqual(calls[1], ['rm', '-f', calls[0]![2]!]);
  });
}
test('cleanup tolerates only the exact missing owned container and surfaces daemon failures', async () => {
  const name = 'nortuscc-image-fixture';
  await removeOwnedImageContainer(async () => { throw Object.assign(new Error('missing'), { code: 1, stderr: `Error response from daemon: No such container: ${name}\n` }); }, name);
  for (const stderr of ['Cannot connect to the Docker daemon', 'Error response from daemon: permission denied', 'Error response from daemon: No such container: unrelated']) {
    await assert.rejects(removeOwnedImageContainer(async () => { throw Object.assign(new Error('failure'), { code: 1, stderr }); }, name));
  }
});
test('container removal completes before the owned database is disposed', async () => {
  const calls: string[] = [];
  await removeOwnedImageContainer(async () => { await Promise.resolve(); calls.push('container removed'); return ''; }, 'nortuscc-image-fixture').then(() => { calls.push('database disposed'); });
  assert.deepEqual(calls, ['container removed', 'database disposed']);
  await assert.rejects(removeOwnedImageContainer(async () => { throw new Error('daemon unreachable'); }, 'nortuscc-image-fixture').then(() => { calls.push('unsafe disposal'); }));
  assert.ok(!calls.includes('unsafe disposal'));
});
