# Desired configuration resolves through base, pins and machine overrides, with provenance

`@nortuscc/profile-engine` is a pure function from the repo's declarations to what a machine
should have. Three layers apply, lowest first: the base profile, pins (`skill-pins.json`, one ref
per source) and machine overrides (`<stateRoot>/overrides.json`). Version 2 of the machine document
also declares personal skills explicitly through `skillAdditions`, with normalized GitHub source,
name, required exposure targets and an optional full commit SHA. These declarations extend only the
skill list. Their declaration provenance is separate from boolean-choice provenance, so enabling an
inherited skill cannot make it appear machine-authored. Targets require native exposure and do not
promise exclusive filesystem visibility in the shared skill store. Every resolved value records the
layer and file that decided it, and excluded items stay in the result switched off, so a UI can
explain any value.

## Considered options

- Per-skill pins: the installer fetches a source at one revision, so a pin moves every skill from
  that source.
- Arbitrary overrides that add keys or name undeclared items would bypass the allowlist. Settings
  and integrations retain the base allowlists; skill booleans may select base skills or explicit
  machine declarations. A same-name skill from another source is a conflict. Addition revisions
  remain source-wide and cannot silently move an inherited source.
- Version 1 remains strict. Version 2 validates known fields and retains unknown top-level fields
  through an explicit serializer, so newer machine intent survives older writers. Malformed
  known fields refuse writes; replacement and migration preserve private backups first.
- Overrides in `state.json`: overrides are user intent that will sync; baselines are bookkeeping.

## Consequences

- Run-time flags (`--target`, `--no-*`, picker choices) are not configuration and are not
  resolved here.
- A followed-setups layer is planned between the defaults and your own setup (#53).
