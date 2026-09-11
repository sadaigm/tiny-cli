#!/bin/bash
# Build and link tiny-cli globally
# This will build the monorepo and link the cli package

# Resolve to absolute path BEFORE any cd below (dirname "$0" is relative when
# invoked as `sh link-global.sh`, so resolving after cd gives the wrong root)
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

rm -rf .turbo
rm -rf packages/cli/dist packages/cli/tsconfig.tsbuildinfo

echo "🏗️ Building project..."
# --force skips the turbo cache — a stale cache hit would link old dist/ output.
pnpm build --force

