# @nortuscc/sync

Machine sync (#43): keeps a machine on the shared setup item by item without losing its overrides.
Decisions: [ADR 0017](../../docs/adr/0017-held-items-compose-over-the-checkout.md) (held items) and
[ADR 0016](../../docs/adr/0016-agent-applies-from-a-verified-snapshot.md) (the agent's snapshots).
[ADR 0037](../../docs/adr/0037-resolved-item-comparison.md) supersedes the comparison clause of ADR 0017.

- **Items.** `itemValues(documents, profile?)` maps every setup item (`setting:`, `file:`, `skill:`, `integration:`)
  to a comparable resolved value before machine overrides, including enablement and referenced bytes.
  `resolvedItemValues(desired, documents)` accepts an already resolved profile; `diffItems` lists changes.
- **Holds.** `<stateRoot>/sync.json` maps a skipped item to the commit whose value it keeps.
- **Composition.** `desiredFor` reads the documents at head (the working tree for the CLI, git objects
  for the agent), resolves every held item under the required `profile` at its held commit, and applies machine overrides.
  Holds from commits without the followed profile are ignored. `composeDocumentsWithStaleHolds` and
  `incoming` return their IDs as `staleHolds`, including when head equals the applied commit.
  Pass those IDs to `droppedOnSwitch({ ..., staleHolds })` to list them alongside missing holds and override paths.
  Existing holds remain visible and releasable in the agent incoming and setup review data.
- **Incoming.** `incoming` lists what moved upstream since the applied commit, from this machine's held
  values, and the overrides those items conflict with.
- **The agent's source.** `setupSourceLayer(paths)` implements `SetupSource` over the own checkout:
  trusted-origin fetch of the tracked ref only, ancestry verification, snapshots under
  `<stateRoot>/snapshots/`.
- It owns the contract the agent codes against (`SetupSource`, `itemIdOf`, `entryOf`, trusted setups);
  the CLI depends on this package, never on the agent.

`ItemKind`, `ItemRef`, `parseItemId` and `normalizeRepoUrl` retain their existing exports
from this package and come from [`@nortuscc/hosted-protocol`](../hosted-protocol/README.md).
`itemIdOf` stays here because it maps engine-resolved observed keys. Item values, held
documents, trusted setups and `SetupSource` also remain local. Normalization compares
repository identity, including local Git fixtures; it grants no trust or fetch permission.
