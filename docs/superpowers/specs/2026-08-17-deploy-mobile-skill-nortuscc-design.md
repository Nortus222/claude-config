# Manage deploy-mobile-apps with nortuscc

## Goal

Make `deploy-mobile-apps` part of the shared Codex and Claude skill set managed by
`nortuscc`. Every configured machine must install the skill from
`Nortus222/agent-skills`, and this machine must use the shared
`~/.agents/skills/deploy-mobile-apps` copy instead of a separate Codex-only copy.

## Design

Add `deploy-mobile-apps` to the existing `[Nortus222/agent-skills]` group in
`skills-manifest.txt`. The manifest remains the only desired-state change. Skill
content stays in the public `agent-skills` repository.

Run the local `nortuscc` CLI from this repository to install and reconcile the
manifest. It will use its existing global skill installer and shared store at
`~/.agents/skills`. Once the shared installation is present and valid, remove the
duplicate `~/.codex/skills/deploy-mobile-apps` directory so Codex cannot load two
copies with the same name.

## Data flow

1. `skills-manifest.txt` names `deploy-mobile-apps` under its source repository.
2. `nortuscc apply --install` installs the named skill into `~/.agents/skills`.
3. Codex discovers the shared user skill from `~/.agents/skills`.
4. Future `nortuscc status`, `update`, and `pull` runs track the skill with the rest
   of the shared set.

## Failure handling

Keep the existing Codex-only copy until the shared installation succeeds and its
files match the merged skill source. If GitHub or the installer is unavailable,
leave the existing copy in place and report that the manifest change is ready but
local reconciliation is incomplete.

## Verification

- Run `npm test` before and after the manifest change.
- Run the repository's manifest and status checks through the local `nortuscc` CLI.
- Confirm `~/.agents/skills/deploy-mobile-apps/SKILL.md` exists and validates.
- Confirm the installed shared skill matches `Nortus222/agent-skills`.
- Confirm only the shared copy remains after removing the Codex-only duplicate.

## Delivery

Commit the manifest change on `feat/add-deploy-mobile-skill`, push it, and open a
pull request against `main`. Do not merge the pull request.
