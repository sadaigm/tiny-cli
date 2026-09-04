#!/bin/bash
# Run tiny-cli directly (bun — OpenTUI's native FFI needs bun or node ≥26.4
# with --experimental-ffi)
# Usage: ./run-direct.sh "your request" or ./run-direct.sh (for REPL)

# Ensure it's built if dist doesn't exist
# if [ ! -d "packages/cli/dist" ]; then
#   pnpm build
# fi
pnpm build
bun packages/cli/dist/index.js "$@"
