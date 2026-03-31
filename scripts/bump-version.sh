#!/bin/bash
#
# Bump version and update dashboard download link
#
# Usage:
#   ./scripts/bump-version.sh patch   # 1.0.1 -> 1.0.2
#   ./scripts/bump-version.sh minor   # 1.0.1 -> 1.1.0
#   ./scripts/bump-version.sh major   # 1.0.1 -> 2.0.0
#   ./scripts/bump-version.sh 1.2.3   # Set specific version
#

set -e

cd "$(dirname "$0")/.."

PACKAGE_JSON="package.json"

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"

# Calculate new version
case "$1" in
    patch)
        NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{$NF = $NF + 1;} 1' OFS=.)
        ;;
    minor)
        NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{$(NF-1) = $(NF-1) + 1; $NF = 0;} 1' OFS=.)
        ;;
    major)
        NEW_VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{$1 = $1 + 1; $2 = 0; $3 = 0;} 1' OFS=.)
        ;;
    "")
        echo "Usage: $0 [patch|minor|major|VERSION]"
        exit 1
        ;;
    *)
        NEW_VERSION="$1"
        ;;
esac

echo "New version: $NEW_VERSION"
echo ""

# Update package.json
echo "Updating package.json..."
sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$PACKAGE_JSON"

echo ""
echo "Version bumped to $NEW_VERSION"
echo ""
echo "Dashboard uses fixed link: https://img.zira.pl/downloads/Zira_AI_Setup.exe"
echo "(No dashboard update needed - link stays the same)"
echo ""
echo "Next steps:"
echo "  1. Run: ./scripts/build-and-upload.sh"
echo "  2. Commit: git add -A && git commit -m 'chore: bump version to $NEW_VERSION'"
