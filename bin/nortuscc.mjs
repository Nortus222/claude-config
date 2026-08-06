#!/usr/bin/env node
const VERBS = ['setup', 'status', 'apply', 'capture', 'pull', 'push', 'update'];

const USAGE = `nortuscc — keep this machine in agreement with claude-config

Usage: nortuscc <command> [options]

Commands:
  setup [--repo URL] [--dir PATH]   clone if absent, apply, install skills, report
  status                            read-only: config / plugins / skills
  apply [--skills] [--take-repo]    repo -> machine
                                    --take-repo resolves a conflict by discarding the local version
  update [--check] [--yes]          adopt, refresh and prune skills, interactively
         [--add N,N] [--prune]      --check reports only; --add and --prune pre-tick rows
  capture [--take-local]            machine -> repo
                                    --take-local resolves a conflict by keeping the local version
  pull                              git pull --ff-only, then apply
  push -m MSG                       capture, then commit and push

Run 'nortuscc status' first; it changes nothing.`;

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
