---
status: accepted (product direction; built through #42)
---

# Individuals with lightweight teams: pin-only updates, item-by-item adoption, per-machine consent

The app serves people running coding agents on several machines; a team is just people following
one lead's setup, with no admins, roles or enforcement. Followers receive only what an author
published at pinned revisions, and only the author watches upstream. Every update splits into
items accepted or skipped one at a time, and each machine applies accepted items under its own
policy (auto-apply, notify or manual). Nobody can apply anything to another person's machine.
Machines are private; sharing a status summary with a team is opt-in. Git stays the source of
truth, and the CLI works with no account.

## Considered options

- Followers tracking upstream live: they would receive content nobody reviewed.
- Organisation admin with enforced settings and remote apply: turns the app into monitoring and
  control.
