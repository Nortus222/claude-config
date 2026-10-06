# Skill pins are full commit SHAs, and installs are verified against the commit

The installer tries `--branch <sha>` before fetching by id, so a pin that looks like a ref name can
install a branch or tag of that name, and the lock's folder hash comes from the GitHub API rather
than from the files on disk. A pin is therefore a 40-character lowercase hex commit SHA, and
nothing else is accepted. The machine installs with `npx skills add <source>#<sha>`, then fetches
that commit by id into a temporary blobless repo, checks that `FETCH_HEAD` is the pinned SHA, and
compares Git blob hashes of the installed files with the pinned skill folder. A mismatch removes
the skill after it was backed up. A changed pin (lock `ref` differs from the pin) reads as
`off-pin` and reinstalls with `add`, never `skills update`, which reinstalls the lock's recorded
ref. Pinned sources are not compared against upstream `HEAD` by `update`. Removing a pin leaves the
lock's `ref` behind, so an unpinned skill that still records one is `off-pin` too and reinstalls
the latest with a ref-less `add`, which drops the recorded ref.

## Considered options

- Fetching ourselves and running `skills add <local path>`: the lock loses its source, so capture
  and update break.
- Trusting the installer: the branch-name trap above.
- GitHub's trees API for verification: GitHub-only.

## Consequences

- Each pinned install step costs one extra blobless fetch; pinned skills already at their pin cost
  nothing.
- SHA-256 repositories cannot be pinned.
- The skills CLI is still `npx -y skills` at latest; verification is what makes that tolerable.
- Skills that bundle scripts (executable, script extension, or under `scripts/` or `bin/`) are
  named in the step note for review.
