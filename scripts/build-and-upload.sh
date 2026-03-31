#!/bin/bash
#
# Build and Upload Zira AI Print Agent to Cloudflare R2
#
# Usage:
#   ./scripts/build-and-upload.sh              # Full build + upload
#   ./scripts/build-and-upload.sh --skip-build # Upload only
#   ./scripts/build-and-upload.sh --version=1.0.2  # Custom version
#
# Requirements:
#   - Node.js 18+
#   - npm packages installed (npm install)
#   - Write access to Cloudflare R2
#

set -e

cd "$(dirname "$0")/.."

echo ""
echo "========================================="
echo "  Zira AI Print Agent - Build & Upload"
echo "========================================="
echo ""

# Check if ts-node is available
if ! npx ts-node --version &>/dev/null; then
    echo "Installing ts-node..."
    npm install -D ts-node typescript @types/node
fi

# Run the TypeScript build script
npx ts-node scripts/build-and-upload.ts "$@"

echo ""
echo "Done!"
