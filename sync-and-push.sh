#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALLER_DIR="$SCRIPT_DIR"
REPO_URL="https://github.com/JoeSzeles/clawscript.git"
CLONE_DIR="/tmp/clawscript-push-$$"

echo "╔════════════════════════════════════════════╗"
echo "║  ClawScript Sync & Push to GitHub          ║"
echo "╚════════════════════════════════════════════╝"
echo ""

echo "[1/6] Running sync-clawscript.sh to pull canonical sources..."
if [ -f "$ROOT_DIR/.openclaw/canvas/sync-clawscript.sh" ]; then
  bash "$ROOT_DIR/.openclaw/canvas/sync-clawscript.sh"
else
  echo "  (sync-clawscript.sh not found, assuming installer is already up to date)"
fi

echo ""
echo "[2/6] Reading and bumping version..."
VERSION_FILE="$INSTALLER_DIR/VERSION"
if [ ! -f "$VERSION_FILE" ]; then
  echo "1.0.0" > "$VERSION_FILE"
fi
CURRENT_VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
PATCH=$((PATCH + 1))
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "$NEW_VERSION" > "$VERSION_FILE"
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "  $CURRENT_VERSION -> $NEW_VERSION (built $BUILD_DATE)"

sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$INSTALLER_DIR/package.json"

echo ""
echo "[3/6] Cloning $REPO_URL..."
rm -rf "$CLONE_DIR"
git clone "$REPO_URL" "$CLONE_DIR" 2>&1 | grep -v "^remote:"
echo ""

echo "[4/6] Copying installer files to clone..."
for dir in lib editor docs test templates strategies examples; do
  if [ -d "$INSTALLER_DIR/$dir" ]; then
    rm -rf "$CLONE_DIR/$dir"
    cp -r "$INSTALLER_DIR/$dir" "$CLONE_DIR/$dir"
    echo "  -> $dir/"
  fi
done
for f in install.sh README.md package.json LICENSE VERSION .gitignore; do
  if [ -f "$INSTALLER_DIR/$f" ]; then
    cp "$INSTALLER_DIR/$f" "$CLONE_DIR/$f"
    echo "  -> $f"
  fi
done

echo ""
echo "[5/6] Running tests..."
cd "$CLONE_DIR"
TEST_OUTPUT=$(node test/test-clawscript-parser.cjs 2>&1)
if echo "$TEST_OUTPUT" | grep -q "ALL TESTS PASSED"; then
  PASS_COUNT=$(echo "$TEST_OUTPUT" | grep "^Total:" | sed 's/.*Passed: \([0-9]*\).*/\1/')
  echo "  All $PASS_COUNT tests passed"
else
  echo "  TESTS FAILED! Aborting push."
  echo "$TEST_OUTPUT" | tail -20
  rm -rf "$CLONE_DIR"
  exit 1
fi

echo ""
echo "[6/6] Committing and pushing..."
cd "$CLONE_DIR"
git add -A

CHANGED_FILES=$(git diff --cached --stat | tail -1)
if [ -z "$CHANGED_FILES" ] || echo "$CHANGED_FILES" | grep -q "0 files changed"; then
  echo "  No changes to push. GitHub is already up to date."
  rm -rf "$CLONE_DIR"
  exit 0
fi

git commit -m "v$NEW_VERSION: sync from OpenClaw workspace

$CHANGED_FILES
Built: $BUILD_DATE"

git push origin main 2>&1

echo ""
echo "════════════════════════════════════════════"
echo "  Pushed v$NEW_VERSION to GitHub"
echo "  $CHANGED_FILES"
echo "════════════════════════════════════════════"

rm -rf "$CLONE_DIR"
