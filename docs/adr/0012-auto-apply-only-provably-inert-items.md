---
status: accepted (classifier and auto-apply built in #77)
---

# Auto-apply changes only items proven inert; only a person on the machine changes trust

Code can arrive through settings keys, copied files and skills, not only through hooks, MCP
servers and plugins. Even on an auto-apply machine, the agent applies only changed instruction
markdown and settings keys in a reviewed `INERT_KEYS` table; every skill, integration, removal and
other file waits for a person on that machine, and drift is never auto-applied. The classifier
reads only the fetched, verified commit, never service data, and fails closed. Which setups a
machine trusts is stored on that machine and changed only by a person there.

## Considered options

- Holding back only integrations: `hooks`, `env`, `statusLine` and `apiKeyHelper` can run code,
  and skills can bundle scripts.
- Trusting pinned skills: pins are verified commits (ADR 0014), but a skill can still bundle scripts,
  so it still waits for a person.

## Consequences

- Adding a key to `INERT_KEYS` is a reviewed code change.
- A remote policy change can switch a machine to auto-apply but cannot release held items.
- An item this machine changed, or holds without a recorded baseline, is drift even when a person
  accepted the upstream change; only a person applies over it.
