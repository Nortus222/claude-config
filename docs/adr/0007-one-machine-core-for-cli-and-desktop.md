# One `@nortuscc/machine` core inspects, plans and executes for the CLI and the desktop app

Every change to a machine goes through one package that both the CLI and the app backend use
in-process. `inspect` produces a report, a pure `plan` produces steps and skipped items with
reasons, and `execute` is the only executor. It holds `<stateRoot>/apply.lock`, backs up to
`<stateRoot>/backups/` before every destructive step, and persists each file step's baseline
before the next runs. All filesystem, process and path access goes through services built once by
`pathsFromEnvironment`, so nothing below it reads the environment or the home directory.

## Considered options

- The app shelling out to the CLI with `--json`: untyped, and parsing duplicated on both sides.

## Consequences

- The state root is `~/.config/nortuscc` (`%APPDATA%\nortuscc` on Windows).
- A lock left by a dead process is taken over.
- Commands move from `.mjs` to TypeScript one at a time until #59.
