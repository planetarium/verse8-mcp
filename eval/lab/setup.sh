#!/usr/bin/env bash
# Builds the white-frame lab under eval/.cache/lab: the shipped Incanto seed
# with src/main.tsx swapped for a loader that boots scenes/<?s=name>.json.
#
#   bash eval/lab/setup.sh             # three as the template pins it
#   bash eval/lab/setup.sh 0.181.2     # same lab against another three
#
# Then: node eval/lab/probe.mjs eval/.cache/lab/app/dist chromium metal template tpl-2048 min-all min-all-1024
set -euo pipefail
EVAL="$(cd "$(dirname "$0")/.." && pwd)"
LAB="$EVAL/.cache/lab"
SEED="$EVAL/seeds/incanto-freeview-shipped"
three="${1:-}"
app="$LAB/app"
[ -n "$three" ] && app="$LAB/three-$three"
[ -d "$SEED" ] || { echo "build the seeds first: node eval/seeds/build-seeds.mjs" >&2; exit 1; }
mkdir -p "$LAB"
rm -rf "$app"
cp -cR "$SEED" "$app" 2>/dev/null || cp -R "$SEED" "$app"
rm -rf "$app/.git" "$app/.claude" "$app/dist"
cp "$EVAL/lab/main.tsx" "$app/src/main.tsx"
mkdir -p "$app/public/scenes"
cp "$app/src/game.scene.json" "$app/public/scenes/template.json"
node "$EVAL/lab/make-scenes.mjs" "$app/public/scenes"
cd "$app"
[ -n "$three" ] && bun add "three@$three" >/dev/null
bunx vite build --base ./ >/dev/null
echo "built $app/dist (three $(node -p "require('./node_modules/three/package.json').version"))"
