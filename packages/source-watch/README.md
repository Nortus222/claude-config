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
renames its default branch, or a cache folder is corrupt (an interrupted fetch, say), delete that
source's cache folder. The cache's git config records each URL as given, credentials included; only
the folder name is hashed. Two sources with the same URL share a folder and may collide in one run;
the loser reports `unreachable`. git runs without a timeout and `GIT_TERMINAL_PROMPT=0` does not stop
ssh prompting on a tty, so a stalled transport stalls that source. Local checkouts are only read,
never fetched.

## Changelog draft

`draftChangelog(reports, accepted)` turns reports into the Markdown changelog Publish starts
from. `accepted` names each source the author brought into Contents, the full sha they reviewed
(it must equal the report's `latest`), the skills to name without detail (`ignored`) and the
upstream-new skills they added (`added`). Up-to-date sources are left out. Sources the draft
cannot describe come back in `skipped` as `not-watched`, `stale` or `no-data`. It is pure and
writes no author names. Design: `docs/superpowers/specs/2026-10-05-source-changelog-design.md`.

```ts
const { markdown, skipped } = draftChangelog(reports, [
  { source: 'obra/superpowers', revision: reports[0].latest!.sha, ignored: ['writing-plans'] },
]);
```

Sources are TypeScript run directly by Node 22.18+, so there is no build step. Tests build git
fixtures in a temporary directory and allow only `file://` transport, so they never reach the
network. Type-checking follows the profile engine's imports, so install both packages first.

```sh
npm ci && (cd ../profile-engine && npm ci)
npm test
npm run typecheck
```
