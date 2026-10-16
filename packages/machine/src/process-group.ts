import { spawn, type ChildProcess } from 'node:child_process';

// Owns termination and bounded joining for one detached child and its descendants.
export const ownedProcessGroup = (child: ChildProcess) => {
  let closed = false;
  let treeKillFailed = false;
  let stopping: Promise<boolean> | undefined;
  child.once('close', () => { closed = true; });
  const gone = () => {
    if (!closed || treeKillFailed) return false;
    if (process.platform === 'win32' || child.pid === undefined) return true;
    try { process.kill(-child.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  };
  const signal = (sig: NodeJS.Signals): Promise<void> => new Promise(done => {
    try {
      if (child.pid === undefined) child.kill(sig);
      else if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
        killer.once('error', () => { treeKillFailed = true; child.kill(sig); done(); });
        killer.once('close', code => { if (code !== 0) treeKillFailed = true; done(); });
        return;
      } else process.kill(-child.pid, sig);
    } catch { /* A vanished group needs no signal. Join checks the actual outcome. */ }
    done();
  });
  const wait = async (ms: number) => {
    const deadline = Date.now() + ms;
    do {
      if (gone()) return true;
      await new Promise<void>(done => setTimeout(done, 10));
    } while (Date.now() < deadline);
    return gone();
  };
  const stop = (termGraceMs = 0): Promise<boolean> => stopping ??= (async () => {
    if (termGraceMs > 0) {
      // Do not let an unresponsive Windows taskkill consume an unbounded grace period.
      void signal('SIGTERM');
      if (await wait(termGraceMs)) return true;
    }
    const deadline = Date.now() + 2000;
    let killCompleted = false;
    void signal('SIGKILL').then(() => { killCompleted = true; });
    while (Date.now() < deadline) {
      if (killCompleted && gone()) return true;
      await new Promise<void>(done => setTimeout(done, 10));
    }
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    return false;
  })();
  return { signal, stop, wait };
};
