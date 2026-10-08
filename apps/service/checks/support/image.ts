import { randomUUID } from 'node:crypto';

export type DockerTransport = (...args: string[]) => Promise<string>;

/** Remove only this test's named container; daemon failures must remain visible. */
export async function removeOwnedImageContainer(docker: DockerTransport, name: string): Promise<void> {
  if (!/^nortuscc-image-[a-z0-9-]+$/.test(name)) throw new Error('Invalid owned image container name.');
  try { await docker('rm', '-f', name); }
  catch (error) {
    const failure = error as { code?: number; stderr?: string };
    if (failure.code !== 1 || failure.stderr?.trim() !== `Error response from daemon: No such container: ${name}`) throw error;
  }
}

/** Own daemon cleanup even when launch fails or the Docker client times out. */
export async function withOwnedImageContainer<A>(docker: DockerTransport, work: (name: string) => Promise<A>): Promise<A> {
  const name = `nortuscc-image-${randomUUID()}`;
  try { return await work(name); }
  finally { await removeOwnedImageContainer(docker, name); }
}
