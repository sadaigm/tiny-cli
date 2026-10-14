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

echo "🔗 Linking packages/cli globally..."
cd packages/cli
# pnpm >= 10 removed `pnpm link --global`; `pnpm add -g .` is the modern
# equivalent for registering a local package's bins into the global bin dir.
# Try the legacy flag first (older pnpm), fall back to `pnpm add -g .`.
if ! pnpm link --global 2>/dev/null; then
  echo "⚠️  pnpm link --global unavailable — falling back to pnpm add -g ."
  if ! pnpm add -g .; then
    echo "❌ Error: pnpm add -g failed."
    echo "Try running 'pnpm setup' first to configure your global bin directory."
    exit 1
  fi
fi

# pnpm's generated shim execs `node`, but the TUI needs bun (OpenTUI FFI).
# Rewrite the tiny-cli shim to launch dist/index.js with bun instead.
# Paths are derived from this script's location — portable across machines.
# pnpm >= 10: `pnpm bin --global` was removed; use `pnpm root -g` + /bin.
# Older pnpm: `pnpm bin --global` still works.
if GLOBAL_BIN="$(pnpm bin --global 2>/dev/null)" && [ -n "$GLOBAL_BIN" ]; then
  : # older pnpm — bin dir resolved
elif GLOBAL_ROOT="$(pnpm root -g 2>/dev/null)" && [ -n "$GLOBAL_ROOT" ]; then
  GLOBAL_BIN="$GLOBAL_ROOT/bin"
else
  echo "❌ Could not resolve the global bin directory."
  exit 1
fi
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
