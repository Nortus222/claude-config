# Desired configuration resolves through base, pins and machine overrides, with provenance

`@nortuscc/profile-engine` is a pure function from the repo's declarations to what a machine
should have. Three layers apply, lowest first: the base profile, pins (`skill-pins.json`, one ref
per source) and machine overrides (`<stateRoot>/overrides.json`). Every resolved value records the
layer and file that decided it, and excluded items stay in the result switched off, so a UI can
explain any value.

## Considered options

- Per-skill pins: the installer fetches a source at one revision, so a pin moves every skill from
  that source.
- Overrides that add keys or name undeclared items: they would bypass the allowlist, so they are
  reported as issues.
- Overrides in `state.json`: overrides are user intent that will sync; baselines are bookkeeping.

## Consequences

- Run-time flags (`--target`, `--no-*`, picker choices) are not configuration and are not
  resolved here.
- A followed-setups layer is planned between the defaults and your own setup (#53).
