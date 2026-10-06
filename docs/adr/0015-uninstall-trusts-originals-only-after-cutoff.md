# Uninstall trusts originals only from runs after a hard cutoff

Uninstall restores a file from its earliest backup, read as what was there before nortuscc. Before
#67 (merged 2026-10-05T23:27:15Z), capture backed the repo copy up at that same path, so a backup
from an earlier run may be repo content rather than the machine's original, and its content cannot
tell the two apart. On the owner's machine every instruction-file backup matches a committed repo
version. A file whose earliest backup comes from a run before the cutoff therefore has no trusted
original: uninstall removes it (moved aside, as always) and names that older backup in its row
instead of restoring it. Later backups are not used as a fallback, because they hold an earlier
nortuscc-managed version, not the original.

## Considered options

- Skipping a backup whose content equals a repo version: reads git history at uninstall time, and
  an original that was captured into the repo is indistinguishable from a capture backup.
- Tagging capture runs: only helps runs written after the change, which already use `<dest>.repo`.
- Using the first backup after the cutoff: restores a managed version as if it were the original.

## Consequences

- A machine set up before 2026-10-05 gets no automatic restore on uninstall; the row names the old
  backup so the owner can put it back by hand.
- The cutoff is the run folder's name, compared as text, so it relies on the `nortuscc-<ISO time>`
  naming. A machine that ran pre-#67 code after the cutoff can still write an untrusted capture
  backup past it.
