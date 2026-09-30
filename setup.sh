#!/usr/bin/env bash
# Install the runtime prerequisites, then start the interactive configuration.
set -eu

if [ "$(uname -s)" != Darwin ]; then
  printf 'This bootstrap supports macOS. On Windows, run setup.ps1.\n' >&2
  exit 1
fi

confirm() {
  local answer
  printf '%s [y/N] ' "$1"
  if ! read -r answer; then
    printf '\nRun this script in an interactive terminal.\n' >&2
    exit 1
  fi
  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

runtime_ready() {
  command -v node >/dev/null 2>&1 &&
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' &&
    command -v npm >/dev/null 2>&1 &&
    command -v npx >/dev/null 2>&1
}

git_ready() {
  local git_path
  git_path="$(command -v git 2>/dev/null)" || return 1
  # Apple's Git stub opens an installer when developer tools are missing.
  if [ "$git_path" = /usr/bin/git ] && ! xcode-select -p >/dev/null 2>&1; then
    return 1
  fi
  git --version >/dev/null 2>&1
}

install_formula() {
  local formula="$1"
  if ! command -v brew >/dev/null 2>&1; then
    printf 'Homebrew is unavailable. Install it from https://brew.sh or use the official installers below.\n' >&2
    return 1
  fi
  if brew list --versions "$formula" >/dev/null 2>&1; then
    brew reinstall "$formula"
  else
    brew install "$formula"
  fi
}

printf 'Checking the tools needed to start configuration...\n'
if ! runtime_ready; then
  if confirm 'Node.js 18+ with npm and npx is required. Install Node.js with Homebrew?'; then
    if ! install_formula node; then
      printf 'Install Node.js and npm from https://nodejs.org/en/download and rerun setup.sh.\n' >&2
    fi
    hash -r
  fi
fi

if ! git_ready; then
  if confirm 'Git is required to download the configuration. Install Git with Homebrew?'; then
    if ! install_formula git; then
      printf 'Install Git from https://git-scm.com/download/mac and rerun setup.sh.\n' >&2
    fi
    hash -r
  fi
fi

if ! runtime_ready || ! git_ready; then
  printf 'Setup requires Node.js 18+, npm, npx, and Git. Install the missing tools, reopen your terminal, and rerun setup.sh.\n' >&2
  exit 1
fi

exec npx --yes github:Nortus222/claude-config setup "$@"
