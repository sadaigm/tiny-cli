#!/bin/bash
# Clean build of all tiny-cli packages.
# Clears TypeScript incremental state, build output, and the turbo cache so
# the build can't be served from a stale/corrupted artifact (which previously
# caused tsc to skip emission and leave packages/core/dist half-written).
# Usage: ./build.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "🧹 Cleaning previous build artifacts..."

# TypeScript incremental cache (composite projects) and emitted output.
find packages -type f -name 'tsconfig.tsbuildinfo' -delete
find packages -type d -name dist -prune -exec rm -rf {} +

# Turbo local + remote cache.
rm -rf .turbo node_modules/.cache

echo "🔨 Building all packages (turbo build)..."
pnpm build

if [ $? -eq 0 ]; then
  echo "✅ Clean build succeeded!"
else
  echo "❌ Clean build failed."
  exit 1
fi
