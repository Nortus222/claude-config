#!/usr/bin/env bash
# Report which enabled plugins / marketplaces from the synced settings.json are
# NOT yet installed on this machine. Read-only: prints the gap and the exact
# `claude plugin ...` commands to close it. Installs nothing.
set -euo pipefail

CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
PLUGINS_DIR="$CLAUDE_DIR/plugins"

if [[ ! -f "$SETTINGS" ]]; then
  echo "plugin-check: no settings.json at $SETTINGS" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "plugin-check: python3 not found; cannot parse JSON." >&2
  echo "             Install Xcode Command Line Tools, or inspect manually with: claude plugin list" >&2
  exit 1
fi

python3 - "$SETTINGS" "$PLUGINS_DIR" <<'PY'
import json, sys, os

settings_path, plugins_dir = sys.argv[1], sys.argv[2]

def load(p, default):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return default

st = load(settings_path, {})
enabled = {k for k, v in st.get("enabledPlugins", {}).items() if v}
markets = st.get("extraKnownMarketplaces", {})  # name -> {source: {...}}

inst = load(os.path.join(plugins_dir, "installed_plugins.json"), {})
installed_plugins = set((inst.get("plugins") or {}).keys())

known = load(os.path.join(plugins_dir, "known_marketplaces.json"), {})
installed_markets = set(known.keys())

def market_source(name):
    s = markets.get(name, {}).get("source", {})
    if s.get("source") == "github" and s.get("repo"):
        return s["repo"]
    if s.get("source") in ("git", "url") and s.get("url"):
        return s["url"]
    return None

missing_markets = [m for m in markets if m not in installed_markets]
missing_plugins = sorted(enabled - installed_plugins)

print("== Claude config: plugin / marketplace sync check ==")
print(f"enabled in settings: {len(enabled)} plugins, {len(markets)} extra marketplaces")
print(f"installed here:      {len(installed_plugins)} plugins, {len(installed_markets)} marketplaces")
print()

if not missing_markets and not missing_plugins:
    print("All enabled plugins and marketplaces are present on this machine.")
    sys.exit(0)

if missing_markets:
    print("Missing marketplaces — add these first:")
    for m in missing_markets:
        src = market_source(m)
        if src:
            print(f"  claude plugin marketplace add {src}")
        else:
            print(f"  # {m}: source not described in settings (built-in?)")
    print()

if missing_plugins:
    print("Missing plugins — install these:")
    for p in missing_plugins:
        print(f"  claude plugin install {p}")
    print()

print("Tip: launching Claude Code with the synced settings.json often auto-installs")
print("     enabled plugins from known marketplaces; re-run this check afterward.")
PY
