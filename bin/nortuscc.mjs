#!/usr/bin/env node
const VERBS = ['setup', 'status', 'apply', 'capture', 'pull', 'push', 'update'];

const USAGE = `nortuscc — keep this machine in agreement with claude-config

Usage: nortuscc <command> [--target claude|codex|all] [options]

Every command accepts --target. It selects which agent's configuration is read
or written; the default is 'all', meaning both Claude and Codex.

Skills-only machines (use this repo's skill set, keep your own agent configuration):
  --skills-only                     record it; configuration files are then
                                    never read, written or captured
  --no-skills-only                  record it off again
  --with-config                     manage config for this one run

Commands:
  setup [--repo URL] [--dir PATH]   clone if absent, apply, then install interactively
  status [--strict] [--versions]    report: cli / config / integrations / skills
                                    and what is installed but undeclared
                                    --strict exits non-zero on undeclared items
                                    --versions shows each plugin's installed version
                                    offers to update nortuscc when it is behind
  apply [--install] [--take-repo]   repo -> machine
                                    --install also offers missing integrations and skills
                                    --take-repo resolves a conflict by discarding the local version

Installation (setup and apply --install):
  --yes                             accept the defaults without opening the selector
                                    (required when there is no terminal to choose on)
  --no-hooks --no-mcp               decline a whole category
  --no-plugins --no-skills
  update [--check] [--yes]          adopt, refresh and prune skills, interactively
         [--add N,N] [--prune]      --check reports only; --add and --prune pre-tick rows
  capture [--take-local]            machine -> repo
                                    --take-local resolves a conflict by keeping the local version
  pull                              git pull --ff-only, then apply
  push -m MSG                       capture, then commit and push

Examples:
  nortuscc status --target codex    report only what Codex owns
  nortuscc apply --target claude    write ~/.claude/CLAUDE.md and nothing else

Run 'nortuscc status' first. It writes nothing on its own; the one thing it
can change is nortuscc itself, and only after you say yes.`;

const [verb, ...rest] = process.argv.slice(2);

if (!verb || verb === '--help' || verb === '-h') {
  console.log(USAGE);
  process.exit(0);
}

if (!VERBS.includes(verb)) {
  console.error(`nortuscc: unknown command '${verb}'\n`);
  console.error(USAGE);
  process.exit(2);
}

const { run } = await import(`../src/commands/${verb}.mjs`);
process.exit(await run(rest));
