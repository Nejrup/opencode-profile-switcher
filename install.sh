#!/bin/sh
# Local development install for opencode-profile-switcher (OpenCode V2).
# Use this when you are editing the plugin; install from GitHub otherwise:
#   opencode plugin add github:Nejrup/opencode-profile-switcher
#
# Why this is needed on current V2 builds:
#  - The server loads plugins listed in opencode.json(c) `plugins`, but the CLI
#    loads TUI plugins ONLY from its own plugin list (cli.json), and
#    path/file entries there are silently DROPPED — only npm / git package
#    specs are resolved. So the reliable way to get both halves in is to
#    register the plugin as a local git package with `opencode plugin add
#    git+file://<this dir>` (which lands in opencode.jsonc) and ALSO add the
#    same spec to cli.json for the TUI half.
#  - The TUI entry must start with `/** @jsxImportSource @opentui/solid */` —
#    without it the host's JSX transform bails and the plugin fails to load.
#
# Requirements: the plugin folder must be a git repo (git+file installs a
# clone of HEAD), and `opencode` must be on PATH.
set -e

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
spec="git+file://$here"
config=${XDG_CONFIG_HOME:-$HOME/.config}/opencode
LISTED=$(opencode plugin list 2>/dev/null || true)

echo "1) committing working tree (git+file installs a clone of HEAD)..."
git -C "$here" add -A
git -C "$here" diff --cached --quiet || git -C "$here" commit -q -m "chore: install/update snapshot"
echo "   HEAD: $(git -C "$here" rev-parse --short HEAD)"

if ! printf '%s' "$LISTED" | grep -q "profile-switcher"; then
  echo "2) registering plugin with the service (opencode.jsonc)..."
  opencode plugin add "$spec"
else
  echo "2) already registered — skipping add (refresh with \`opencode plugin update\`)"
fi

echo "3) ensuring the CLI (TUI) registration in cli.json..."
python3 - "$config/cli.json" "$spec" <<'EOF'
import json, sys
path, spec = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(path))
except Exception:
    d = {"$schema": "https://opencode.ai/v2/cli.json"}
plug = d.setdefault("plugins", [])
if spec not in plug:
    plug.append(spec)
    json.dump(d, open(path, "w"), indent=2)
    print("   added to cli.json")
else:
    print("   already present")
EOF

cat <<EOF

Done. Restart the service once so the server picks up the new config:

  opencode service restart

Dev loop after editing src/:  git commit  →  opencode plugin update
(or remove + add) and re-open the TUI.
EOF