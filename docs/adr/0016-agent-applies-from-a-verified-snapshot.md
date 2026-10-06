---
status: accepted
---

# The agent inspects and applies from a verified snapshot, never the working tree

The config domain reads copied files and `settings.keys.json` from `MachinePaths.repo`, and
`fetch()` never touches the checkout, so applying from the working tree would install whatever it
holds rather than the accepted, verified commit. `SetupSource.load` and `effective` therefore
return `{ desired, repo }`, where `repo` is a directory holding exactly that configuration's files,
and each job runs its domains with `MachinePaths.repo` pointed at the effective snapshot. Every
domain a job runs must read repo files through the job's paths, not paths captured at
construction.

## Considered options

- Applying from the checkout: what is installed would depend on uncommitted edits and on whatever
  branch is checked out, not on the commit that was verified and accepted.

## Consequences

- #43 must materialise a directory per effective configuration.
- The integrations domain still captures its paths at construction; #78 must fix that before
  person-initiated applies.
