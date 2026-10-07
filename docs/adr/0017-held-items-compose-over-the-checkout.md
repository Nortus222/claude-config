---
status: accepted
---

# A machine's desired setup is the checkout with held items patched in from git

The checkout follows `origin` because it also carries the CLI's own code, so a person who skips an
upstream change cannot simply stay on an older commit. Machine sync (#43) therefore records each
skipped item in `<stateRoot>/sync.json` as the commit whose value it keeps, and one composition,
`composeDocuments` (wrapped by `desiredFor`), builds what a machine should have: the documents at
head (the working tree for the CLI, git objects for the agent) with every held item patched to its
held value, resolved with this machine's overrides by `loadProfile`. `apply`, `status`, `sync`
and the agent compose it, so those four agree on what the machine should have. Items are compared
from documents alone, never through overrides, so an override cannot hide an upstream change; an
incoming item an override shadows is a conflict that is kept unless the person takes theirs, which
removes that override after backing up `overrides.json`.

## Considered options

- Separating configuration from code into two checkouts: a larger change to setup, update and the
  launcher than per-item holds.
- Pinning the whole checkout at the last accepted commit: one skipped item would block every other
  change, and the CLI's own updates with it.

## Consequences

- A skill hold moves its source's pin, because pins are per source (ADR 0006).
- `update`, `setup`, `uninstall`, `capture` and `push` do not see holds yet; they read the checkout
  directly. `update` can reinstall a skill held at an older pin, and `update --prune` can remove a
  skill upstream deleted that the person skipped. `capture` and `push` can publish a held item
  back to the repo. Teaching them to compose is a known follow-up.
- The applied commit lives in `state.json` (`applied`), written only after a successful apply.
- An invalid `sync.json` refuses `sync`, `apply` and `status` and is never rewritten.
- The CLI composes into a private per-command temp directory; the agent composes snapshots keyed by
  (format version, commit, holds) and re-checks the origin's trust on every `effective`.
