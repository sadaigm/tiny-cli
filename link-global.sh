#!/bin/bash
# Build and link tiny-cli globally
# This will build the monorepo and link the cli package

echo "🏗️ Building project..."
pnpm build

echo "🔗 Linking packages/cli globally..."
cd packages/cli
if ! pnpm link --global; then
  echo "❌ Error: pnpm link failed."
  echo "Try running 'pnpm setup' first to configure your global bin directory."
  exit 1
fi

echo "✅ Success! You can now use 'tiny-cli' from any directory."
