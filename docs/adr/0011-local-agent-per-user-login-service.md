---
status: accepted (core built in #77; login service built in #79; IPC and app cutover #78)
---

# A per-user login service keeps each machine on its policy; the CLI stays standalone

Accepted items must apply while the app is closed and on headless machines. `packages/agent` runs
as a per-user login service (LaunchAgent, `systemd --user`, a logon Scheduled Task) and replaces
the app's Bun sidecar; the app becomes its client over a user-only socket or named pipe with a
per-start token. The CLI keeps running in-process and shares only `apply.lock`. The agent
schedules by timer plus events, pauses auto-apply after any failed or interrupted run until a
person resumes it, and never downloads code; whoever installed it upgrades it.

## Considered options

- A system service: runs as another user, without the user's homes or keychain.
- A menu-bar app: stops when the app quits.
- A loopback TCP port: reachable from browsers.
- Watching files: mostly reports the agents' own writes to `~/.claude`.
- Automatic retries: a crash loop could keep changing the machine.
