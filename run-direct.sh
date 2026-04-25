#!/bin/bash
# Run tiny-cli directly from node
# Usage: ./run-direct.sh "your request" or ./run-direct.sh (for REPL)

# Ensure it's built if dist doesn't exist
# if [ ! -d "packages/cli/dist" ]; then
#   pnpm build
# fi
pnpm build
node packages/cli/dist/index.js "$@"
