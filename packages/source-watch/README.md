# Sources watcher

Watches the skill sources a setup uses. For each source it reports the latest upstream revision,
whether it is ahead of the source's baseline (its pin), the commits between them, the setup's
skills that changed with their `SKILL.md` diffs, and, for the author's own checkouts, edits not
yet pushed. It is the data layer behind the desktop app's Sources screen (#52). Nothing uses it
yet. Design: `docs/superpowers/specs/2026-10-05-source-watch-design.md`.

```ts
import { Effect } from 'effect';
import { nodeGit, sourcesFrom, watchSources } from '@nortuscc/source-watch';

const sources = sourcesFrom(desiredConfig, { checkouts: { 'Nortus222/agent-skills': '/work/agent-skills' } });
const reports = await Effect.runPromise(
  watchSources(sources, { cacheDir: '/path/to/cache' }).pipe(Effect.provide(nodeGit())),
);
```

Each source keeps a bare partial clone in `cacheDir`, refreshed on every run. If an upstream
renames its default branch, delete that source's cache folder. Local checkouts are only read,
never fetched.

Sources are TypeScript run directly by Node 22.18+, so there is no build step. Tests build git
fixtures in a temporary directory and allow only `file://` transport, so they never reach the
network. Type-checking follows the profile engine's imports, so install both packages first.

```sh
npm ci && (cd ../profile-engine && npm ci)
npm test
npm run typecheck
```
