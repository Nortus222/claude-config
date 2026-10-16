---
status: accepted
---

# Compare and hold resolved profile items

Named profiles inherit declarations and replace file paths, so comparing root documents misses changes that their followers receive. Superseding ADR 0017's comparison clause, sync compares the selected profile's resolved items before machine overrides, including skill installation, integration enablement, copied configuration and referenced hook bytes, while ignoring provenance-only changes. Holds keep their existing item-to-commit format and resolve each held value under the currently followed profile; composition materializes the selected declarations and matching bytes before applying machine overrides, preserving ADR 0016's `{ desired, repo }` contract. Shared skill-source pins remain coupled, and hosted adoption still refuses per-item origins that cannot preserve every confirmed sibling value. Snapshot format 2 includes repository and profile identity to prevent cross-profile reuse; profile switches enumerate obsolete holds and override paths without changing either on-disk format.
