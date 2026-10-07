export const VERBS = ['setup', 'status', 'apply', 'capture', 'sync', 'pull', 'push', 'update', 'uninstall', 'agent'];

export const USAGE = `nortuscc — keep this machine in agreement with claude-config

Usage: nortuscc <command> [--target claude|codex|all] [options]

Most commands accept --target. It selects which agent's configuration is read
or written; the default is 'all', meaning both Claude and Codex. Uninstall is
machine-wide and accepts only --target all.

Skills-only machines (use this repo's skill set, keep your own agent configuration):
  --skills-only                     record it; configuration files are then
                                    never read, written or captured
  --no-skills-only                  record it off again
  --with-config                     manage config for this one run

Commands:
  setup [--repo URL] [--dir PATH]   choose skills alone or either/both agent configs,
                                    offer missing tools and account setup one by one,
                                    then install selected items; npx defaults to
                                    ~/claude-config when --dir is omitted
  status [--strict] [--versions]    report: cli / config / integrations / skills
                                    and what is installed but undeclared
                                    --strict exits non-zero on undeclared items
                                    --versions shows each plugin's installed version
                                    offers to update nortuscc when it is behind
  apply [--install] [--take-repo]   repo -> machine
                                    --install also offers missing integrations and skills
                                    --take-repo resolves a conflict by discarding the local version

Installation (setup and apply --install):
  --yes                             accept the saved config choice and default items
                                    skips prerequisite installation and authentication
                                    (required when there is no terminal to choose on)
  --no-hooks --no-mcp               decline a whole category
  --no-plugins --no-skills
  update [--check] [--yes]          adopt, refresh and prune skills, interactively
         [--add N,N] [--prune]      --check reports only; --add and --prune pre-tick rows
  capture [--take-local]            machine -> repo
                                    --take-local resolves a conflict by keeping the local version
  sync [--check] [--yes]            fetch the setup, preview what changed item by item,
       [--skip ID,ID]               take what you tick (your overrides stay), then apply
       [--take-theirs ID,ID]        --check previews only and exits 1 when items wait
       [--release ID]               --skip holds items at their current value
                                    --take-theirs drops the override an item conflicts with
                                    --release takes a held item after all
  pull                              the same as sync
  push -m MSG                       capture, then commit and push
  uninstall --yes [--force]         restore or remove managed configuration,
                                    then switch this machine to skills-only mode
                                    integrations, skills and the repo stay installed;
                                    --target must be all
  agent install [--linger]          run the local agent as a login service from this checkout
                                    --linger (Linux) keeps it running with nobody logged in
  agent uninstall                   stop the agent and remove its login service
  agent run                         run the agent in the foreground (the service runs this)
  agent status                      show the running agent's policy, pause and pending items
  agent resume                      resume a paused agent
  agent policy <auto-apply|notify|manual>
                                    set how the agent treats accepted items

Examples:
  nortuscc status --target codex    report only what Codex owns
  nortuscc apply --target claude    write ~/.claude/CLAUDE.md and nothing else

PowerShell: use nortuscc.cmd when script execution is disabled.

Run 'nortuscc status' first. It writes nothing on its own; the one thing it
can change is nortuscc itself, and only after you say yes.`;
