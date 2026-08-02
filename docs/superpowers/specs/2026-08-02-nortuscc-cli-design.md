# `nortuscc` — a CLI for claude-config

**Date:** 2026-08-02
**Status:** Design approved, pending implementation plan
**Supersedes:** `bootstrap.sh`, `bootstrap-windows.sh`, `plugin-check.sh`, `skills-check.sh`

## 1. Problem

The config in this repo reaches a machine through four shell scripts that disagree with
each other, and nothing checks whether it arrived.

**Measured drift on the Windows machine, 2026-08-02:**

| File | State |
| --- | --- |
| `claude/bin/sp` | Absent from `~/.claude/bin/` entirely |
| `claude/bin/sdd-pkg.sh` | Present but differs from the repo copy |
| `claude/hooks/` | Never synced on Windows by design |

Both `bin/` entries are load-bearing: the global `CLAUDE.md` instructs agents to run
`bash ~/.claude/bin/sp <skill> <script>` and `bash ~/.claude/bin/sdd-pkg.sh` for review
packages. One is missing and the other is stale, and no tool reports either.

The cause is structural:

- **`bootstrap.sh`** (macOS) symlinks four things — `settings.json`, `CLAUDE.md`, `bin/`,
  `hooks/` — giving live sync.
- **`bootstrap-windows.sh`** copies two — `settings.json`, `CLAUDE.md` — giving a
  snapshot that drifts silently. `bin/` and `hooks/` are skipped.
- **`plugin-check.sh`** and **`skills-check.sh`** report plugin and skill gaps. Nothing
  reports config-file gaps.

Two further faults, both pre-existing:

- `bootstrap.sh` still carries the literal placeholder `git@github.com:OWNER/claude-config.git`.
- Its default `CLONE_DIR` is `~/.config/claude-config`; the actual clone is `~/dev/claude-config`.

A third fault is documented but undetected: if Claude Code rewrites `settings.json` via
atomic temp-file+rename, the symlink becomes a regular file and syncing stops with no
signal.

## 2. Goals

1. **Make silent drift impossible.** One read-only command reports every divergence
   between repo and machine — config files, plugins, skills — and how to fix each.
2. **One entry point.** Six verbs replacing four scripts.
3. **One code path across platforms.** The mac/Windows split is replaced by a per-file
   property: does an agent write to this file?
4. **Trivial onboarding and sharing.** One command sets up a bare machine end to end.

## 3. Non-goals

- **Vendoring skill content.** Skill files are never copied into this repo. They install
  from `Nortus222/agent-skills` and third-party upstreams via the `skills` CLI, which this
  CLI drives (§6.1). Vendoring would force every machine onto an identical set; installing
  leaves hand-authored local skills alone.
- **Reimplementing the `skills` CLI.** `nortuscc` shells out to `npx skills`. It owns
  *which* skills a machine should have; the `skills` CLI owns fetching and placing them.
- **Removing skills.** `apply` only ever adds. A skill present on a machine but absent
  from the manifest is reported, never deleted — that is how per-machine extras are
  allowed to exist (§6.1).
- **Installing plugins.** `status` reports plugin gaps and prints the
  `claude plugin install` commands; it runs none of them. Plugins are largely
  auto-installed by Claude Code from synced `settings.json`, so the gap is informational.
- **JSON-aware merging of `settings.json`.** Considered and rejected for now; conflicts
  are refused and reported instead. Revisit only if conflicts prove frequent in practice.
- **Managing anything outside `~/.claude`, `~/.agents/skills`, and the checks above.**

## 4. Decisions

| Axis | Decision |
| --- | --- |
| Runtime | Node, plain ESM `.mjs`, no build step |
| Distribution | `npx github:Nortus222/claude-config` — no npm publish |
| Command name | `nortuscc` |
| Sync model | Hybrid: symlink directories, copy agent-rewritten files |
| Drift detection | Baseline hashes in a machine-local lockfile; three-way comparison |
| Conflicts | Refuse, report, back up. Never guess |
| Git | `pull` and `push` wrap it; `push` requires an explicit `-m` |
| Skills | Owned by the same four directional verbs; fetching delegated to `npx skills` |
| Skill installs | On `setup` always; on `apply` only with `--skills` |
| Old scripts | All four deleted |

**Why `npx github:`** — it runs on a machine with nothing cloned, so the CLI clones
itself. This removes today's chicken-and-egg, where `bootstrap.sh` can only run from a
clone it is itself responsible for creating. It costs no npm package name and no release
process.

**Why hybrid sync** — the README's premise that Windows cannot symlink is no longer true
on the current machine: `npx skills` created `~/.claude/skills/explain` as a real symlink,
and `ln -s` succeeds. The real hazard is per-file, not per-platform: `settings.json` and
`CLAUDE.md` are rewritten in place by Claude Code, so a symlink to them can be silently
replaced. `bin/` and `hooks/` are never written by an agent, so they link safely.

## 5. Architecture

```
claude-config/
  package.json              bin: { nortuscc: ./bin/nortuscc.mjs }, type: module
  bin/nortuscc.mjs          arg parsing + dispatch only
  src/
    manifest.mjs            the sync map — single source of truth
    resolve.mjs             locate the repo and ~/.claude on this machine
    lock.mjs                read/write ~/.claude/.nortuscc-lock.json
    state.mjs               pure: (baseline, repo, local) -> state
    link.mjs                symlink/junction operations for directories
    copy.mjs                copy operations for files
    plugins.mjs             plugin gap report (ports plugin-check.sh)
    skills.mjs              desired-vs-installed reconciliation + manifest parse/emit
    skills-cli.mjs          the only place `npx skills` is invoked
    report.mjs              output formatting
  claude/                   settings.json, CLAUDE.md, bin/, hooks/
  skills-manifest.txt       source-grouped desired skill set
```

Each module answers one question and can be read without the others. `state.mjs` is pure
and is the part worth testing hardest; the fs modules stay thin wrappers so that the
logic worth getting right is not tangled with the I/O.

### 5.1 The sync manifest

One declarative table that every command reads. Adding a synced path is one line, and no
command needs to change.

```js
export const SYNC = [
  { src: 'claude/bin',           dest: 'bin',           mode: 'link' },
  { src: 'claude/hooks',         dest: 'hooks',         mode: 'link' },
  { src: 'claude/settings.json', dest: 'settings.json', mode: 'copy' },
  { src: 'claude/CLAUDE.md',     dest: 'CLAUDE.md',     mode: 'copy' },
];
```

`dest` is relative to `~/.claude`. `mode` encodes the rule from §4: `link` for anything an
agent never writes, `copy` for anything it does.

### 5.2 The lockfile

`~/.claude/.nortuscc-lock.json`. Machine-local by construction — it lives outside the
repo, so it is never synced and never conflicts.

```json
{
  "version": 1,
  "repo": "C:/Users/nortu/dev/claude-config",
  "files": {
    "settings.json": { "hash": "sha256:…", "appliedAt": "2026-08-02T09:30:00Z" },
    "CLAUDE.md":     { "hash": "sha256:…", "appliedAt": "2026-08-02T09:30:00Z" }
  }
}
```

`hash` is the content hash at the moment of the last successful `apply` or `capture` —
the baseline both sides are compared against. `repo` records where the clone lives, so
`nortuscc` works from any working directory and the `~/.config` vs `~/dev` mismatch
cannot recur.

Hashing normalises line endings before digesting, so a CRLF checkout does not read as
drift against an LF repo.

### 5.3 State

For copied files, comparing baseline against both sides gives four states:

| repo vs baseline | local vs baseline | state | `apply` | `capture` |
| --- | --- | --- | --- | --- |
| same | same | `clean` | — | — |
| changed | same | `repo-ahead` | copy repo → local | — |
| same | changed | `local-ahead` | warn, skip | copy local → repo |
| changed | changed | `conflict` | refuse + back up | refuse + back up |

A missing baseline (first run, or a file added to the manifest since) is `unmanaged`:
`apply` writes it and records a baseline, backing up anything already there.

For linked directories the states are `linked`, `missing`, `wrong-target`, and
`clobbered` — a real file or directory sitting where a link belongs. `clobbered` is the
silent failure mode from §1; `apply` repairs it after backing up what it displaces.

## 6. Commands

```
nortuscc setup [--repo URL] [--dir PATH]    clone if absent → apply → install skills → status
nortuscc status                             read-only: config / plugins / skills
nortuscc apply   [--skills] [--take-repo|--take-local]   repo → machine
nortuscc capture [--take-repo|--take-local] machine → repo (incl. skills manifest)
nortuscc pull                               git pull --ff-only → apply
nortuscc push -m MSG                        capture → commit → push
```

`apply` stays fast and offline-safe by default: it reports missing skills without
fetching. `--skills` opts into installing them. `setup` always installs, because that is
the moment a bare machine needs them.

**`status`** prints three sections and writes nothing. It exits non-zero when anything is
adrift, so it can gate a shell prompt or a scheduled check.

```
$ nortuscc status

config
  bin/            linked
  hooks/          clobbered   real dir where a link belongs
  settings.json   local-ahead 2 allow rules not in repo
  CLAUDE.md       clean

plugins
  ok — 14 enabled, 14 installed

skills
  missing   design-an-interface, to-issues   [mattpocock/skills]
  extra     wayfinder, implement             not in manifest
  local     my-scratch-skill                 no source, never installable

3 items need attention:  nortuscc apply           (hooks/)
                         nortuscc apply --skills  (2 missing)
                         nortuscc push            (settings.json)
```

**`apply`** and **`capture`** move files in one direction only and refuse conflicts. The
`--take-repo` / `--take-local` flags are the sole way to resolve one, and they are the
only way to lose an edit.

**`push`** requires `-m`. It prints the diffstat of what `capture` staged and commits only
those paths — never `git add -A`. Nothing is committed that the manifest does not own.

**`plugins`** is a section of `status`, not a verb, and is a read-only port of
`plugin-check.sh`: diff `settings.json`'s `enabledPlugins` and `extraKnownMarketplaces`
against this machine's `installed_plugins.json` and `known_marketplaces.json`, and print
the `claude plugin install` commands for anything absent.

### 6.1 Skills

Skills need no verbs of their own. They are a second thing the same four directional verbs
act on, with the fetching delegated to the `skills` CLI.

| Verb | Effect on skills |
| --- | --- |
| `setup` | Install everything in the manifest |
| `apply` | Report only, unless `--skills` is passed, then install what is missing |
| `capture` | Regenerate `skills-manifest.txt` from what is installed |
| `status` | Report missing and extra |

**The manifest becomes source-grouped**, because provenance has to live in the repo to be
restorable. `~/.agents/.skill-lock.json` records each skill's source repo, but it is
machine-local — on a fresh machine it is empty and cannot say where anything came from.

```
[Nortus222/agent-skills]
explain

[mattpocock/skills]
teach
grill-me
codebase-design

[vercel-labs/skills]
find-skills
```

**Installing** is one `skills` invocation per source, using `--skill` to restore a precise
subset rather than everything a repo happens to publish:

```bash
npx skills add mattpocock/skills --skill teach,grill-me,codebase-design -g -y
```

**Capturing** reads `~/.agents/.skill-lock.json`, groups the installed skills by their
recorded `source`, and rewrites the manifest. This is how the manifest stays honest
without hand-maintenance: install a skill the normal way, then `nortuscc capture`.

**Extra skills are never removed.** A skill present on a machine but absent from the
manifest is reported as `extra`, never deleted. That is the mechanism by which a machine
carries the shared union plus its own locally authored skills — the property that decided
against vendoring in the first place. `capture` would fold an extra into the manifest, so
it is only run when the intent is to share.

Skills whose lock entry has no source (hand-authored directly in `~/.agents/skills/`) are
reported as `local` and never written to the manifest, since there is nothing to install
them from.

`status` also flags broken symlinks under `~/.claude/skills/`, preserving
`skills-check.sh`'s one behaviour that is not about the manifest.

All `npx skills` invocation is confined to `skills-cli.mjs`, so the rest of the CLI deals
in skill names and sources and never in subprocess details.

## 7. Safety

- Anything destructive backs up to `~/.claude/backups/nortuscc-<stamp>/` first, preserving
  relative paths.
- The CLI refuses rather than guesses. No command silently picks a winner.
- `status` never writes, including no lockfile updates.
- `push` commits only manifest-owned paths, and only with an explicit message.
- Every write is idempotent: re-running `apply` on a clean machine changes nothing and
  reports `clean`.

## 8. Platform handling

Node's `fs` covers the differences, with one deliberate choice: directory links are
created as **junctions** on Windows (`fs.symlink(target, path, 'junction')`). Junctions
require no elevation and no Developer Mode, so `bin/` and `hooks/` link on any Windows
machine — strictly better than both current scripts, one of which needs Developer Mode
and the other of which skips those paths entirely.

Path handling goes through `node:path` and `os.homedir()`, so `cygpath` and the
`USERPROFILE` versus Git Bash `$HOME` divergence disappear.

## 9. Migration

1. Add the CLI and prove `status` reports the §1 drift on this machine.
2. **Check the direction of every `bin/` divergence before the first `apply`.**
   `~/.claude/bin/` is a real directory here, so `apply` will classify it `clobbered`,
   back it up, and replace it with a link — the local contents then survive only in
   `~/.claude/backups/`. That is safe only when the repo side is the newer one.

   As of `0eafc4d` it is: the repo's `sdd-pkg.sh` is the 85-line submodule-aware version
   and the local copy is the older 43-line one, so `apply` is a pure upgrade here. The
   check still belongs in the sequence, because this was not true an hour earlier and the
   failure is silent when it is not.
3. Run `apply`; confirm `sp` appears and `sdd-pkg.sh` matches the repo.
3. Delete `bootstrap.sh`, `bootstrap-windows.sh`, `plugin-check.sh`, `skills-check.sh`.
4. Rewrite `README.md` around the six verbs, dropping the manual git ceremony and the
   "Windows uses copies" section.
5. Convert `skills-manifest.txt` to the source-grouped format by running
   `nortuscc capture` against the current machine, which reads provenance out of
   `~/.agents/.skill-lock.json`. Review the result before committing: the two entries with
   no match on this machine — `design-an-interface` and `to-issues`, which look like
   upstream renames to `codebase-design` and `to-tickets` — will not survive a capture,
   since capture emits what is installed. Confirm the rename rather than letting the
   capture silently drop them.

The mac path cannot be verified from the authoring machine. `setup` and `apply` must be
run once on the mac and the result recorded before the old scripts are considered dead;
step 3 may land in the same change, but the verification is outstanding until then.

## 10. Testing

`node:test`, no framework.

- **`state.mjs`** — the full matrix of §5.3, including `unmanaged` and the
  CRLF-normalisation case. Pure input to output; the highest-value tests here.
- **`manifest` resolution** — every entry resolves to a real repo path.
- **`apply` / `capture` against a temp `~/.claude`** — idempotency, backup-before-write,
  conflict refusal, and `clobbered` repair.
- **`plugins`** — gap detection against fixture JSON.
- **`skills`** — manifest round-trip (parse → emit → parse is stable), reconciliation of a
  fixture manifest against a fixture `.skill-lock.json` producing the four buckets
  (`ok`, `missing`, `extra`, `local`), and the grouping of missing skills into one
  `skills add` argument list per source.

Not tested: the git wrappers in `pull` and `push`, and the `npx skills` subprocess in
`skills-cli.mjs`. Both are thin shells over external tools; the logic worth testing sits
on this side of those boundaries, which is why `skills-cli.mjs` exists as a seam.

## 11. Risks

| Risk | Handling |
| --- | --- |
| Mac path unverified from this machine | §9 requires a real run before the scripts are trusted as dead |
| A conflict blocks a machine mid-work | Backups are written before the refusal; `--take-*` is always available |
| Lockfile lost or corrupted | Treated as first run: every file becomes `unmanaged`, backed up and re-baselined rather than overwritten blind |
| `npx github:` resolves a stale commit | `setup` prints the resolved commit; `pull` is the supported update path afterwards |
| CRLF checkout reads as permanent drift | Hashing normalises line endings (§5.2) |
| `skills` CLI changes its flags or lock format | Confined to `skills-cli.mjs`; `status` degrades to reporting rather than failing if the lock cannot be parsed |
| `capture` silently drops a skill that failed to install | Capture emits only what is installed, so a failed install would quietly leave the manifest. `capture` prints removed entries and requires confirmation when the manifest shrinks |
| An upstream renames a skill | Shows as `missing` plus `extra` in the same report, which is the signature of a rename; §9 calls out the two current cases |
