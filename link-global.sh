#!/bin/bash
# Build and link tiny-cli globally
# This will build the monorepo and link the cli package

# Resolve to absolute path BEFORE any cd below (dirname "$0" is relative when
# invoked as `sh link-global.sh`, so resolving after cd gives the wrong root)
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "🏗️ Building project..."
pnpm build

echo "🔗 Linking packages/cli globally..."
cd packages/cli
if ! pnpm link --global; then
  echo "❌ Error: pnpm link failed."
  echo "Try running 'pnpm setup' first to configure your global bin directory."
  exit 1
fi

# pnpm's generated shim execs `node`, but the TUI needs bun (OpenTUI FFI).
# Rewrite the tiny-cli shim to launch dist/index.js with bun instead.
# Paths are derived from this script's location — portable across machines.
GLOBAL_BIN="$(pnpm bin --global)"
if [ -f "$GLOBAL_BIN/tiny-cli" ]; then
  cat > "$GLOBAL_BIN/tiny-cli" <<SHIM
#!/bin/sh
exec bun "$REPO_ROOT/packages/cli/dist/index.js" "\$@"
SHIM
  chmod +x "$GLOBAL_BIN/tiny-cli"
  echo "🔧 Rewrote $GLOBAL_BIN/tiny-cli to run under bun."
else
  echo "⚠️  $GLOBAL_BIN/tiny-cli not found — skipping shim rewrite."
fi

echo "✅ Success! You can now use 'tiny-cli' from any directory."
