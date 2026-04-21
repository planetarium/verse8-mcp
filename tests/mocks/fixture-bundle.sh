#!/bin/sh
# tests/mocks/fixture-bundle.sh
#
# Creates a local bare git bundle at /tmp/verse8-smoke-bundle.git
# suitable for use as a clone source in smoke tests.
#
# The bundle simulates a project repo cloned from gitlab.verse8.io.
# Usage: bash tests/mocks/fixture-bundle.sh [--origin-url <url>]

set -eu

BUNDLE_DIR="/tmp/verse8-smoke-bundle.git"
WORK_DIR="/tmp/verse8-smoke-bundle-work"
ORIGIN_URL="https://gitlab.verse8.io/test/fixture.git"

# Parse optional --origin-url override
while [ $# -gt 0 ]; do
  case "$1" in
    --origin-url)
      ORIGIN_URL="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# Clean up previous
rm -rf "$BUNDLE_DIR" "$WORK_DIR"

# 1. Create a working repo with one commit
mkdir -p "$WORK_DIR"
git init "$WORK_DIR" -b main >/dev/null 2>&1 || git init "$WORK_DIR" >/dev/null 2>&1
(
  cd "$WORK_DIR"
  git config user.email "smoke@verse8.io"
  git config user.name "Smoke Test"

  # Ensure we're on main branch (git < 2.28 may default to master)
  git checkout -b main 2>/dev/null || true

  echo "# Verse8 Fixture Project" > README.md
  echo "This is a fixture repository for smoke testing." >> README.md
  git add README.md
  git commit -m "Initial commit" --allow-empty

  # Real verse8 projects are cloned on the `develop` branch. The mock's
  # cloneCommand matches that, so the fixture needs the branch to exist.
  git checkout -b develop
)

# 2. Clone as bare repo (the bundle)
git clone --bare "$WORK_DIR" "$BUNDLE_DIR" >/dev/null 2>&1

# 3. Set the fake origin URL in the bundle config
(
  cd "$BUNDLE_DIR"
  git config remote.origin.url "$ORIGIN_URL"
)

rm -rf "$WORK_DIR"

echo "[fixture-bundle] Created $BUNDLE_DIR with origin: $ORIGIN_URL"
