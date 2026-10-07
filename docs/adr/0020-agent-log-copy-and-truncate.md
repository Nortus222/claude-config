---
status: accepted
---

# Copy and truncate the agent log under its PID lock

Unix service managers keep append descriptors open on `agent.log`, so renaming the active file would send later writes to an archive. The agent therefore checks at startup and every 60 seconds while holding `agent.lock`, rotates at 1 MiB, and retains three archives. It first copies the active log to a temporary sibling, shifts older archives only after that copy succeeds, atomically installs the copy as `.1`, then truncates the active inode. The archive is the backup before truncation; rotation failures preserve the active log and report a diagnostic without stopping the agent. Scope closure stops the timer and awaits its active check before releasing the lock. Copy-and-truncate can lose writes made between the completed copy and truncation, and the interval permits growth beyond 1 MiB between checks. These limits are acceptable for diagnostic retention because preserving Unix service-manager descriptors avoids replacing their logging contract or intercepting their streams. Windows uses the same rotation with an agent-owned append descriptor (ADR 0018).
