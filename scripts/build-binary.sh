#!/bin/sh
# Build a self-contained tiny-cli binary + release tarball with Bun.
#
# Usage: scripts/build-binary.sh [target]
#   target: linux-x64 (default: current machine), linux-arm64, darwin-x64, darwin-arm64, win-x64
#
# Output: dist-bin/tiny-cli-<version>-<target>.tar.gz (or .zip for win-x64)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(grep -o '"version": *"[^"]*"' "$ROOT/packages/cli/package.json" | head -1 | sed 's/.*"\([0-9][^"]*\)"$/\1/')"

# Current machine as a target name (uname -m normalized: x86_64 -> x64, aarch64 -> arm64)
current_target() {
  local_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  local_arch="$(uname -m)"
  case "$local_arch" in
    x86_64|amd64) local_arch=x64 ;;
    aarch64|arm64) local_arch=arm64 ;;
  esac
  echo "$local_os-$local_arch"
}

TARGET="${1:-$(current_target)}"

case "$TARGET" in
  linux-x64|linux-arm64|darwin-x64|darwin-arm64|win-x64) ;;
  *) echo "error: unsupported target '$TARGET'" >&2; exit 1 ;;
esac

command -v bun >/dev/null 2>&1 || {
  echo "error: bun is not installed. Install it with:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
}

OUTDIR="$ROOT/dist-bin/$TARGET"
BINARY_NAME="tiny"
[ "$TARGET" = "win-x64" ] && BINARY_NAME="tiny.exe"

echo "==> Building $TARGET (version $VERSION)"
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

# Resolve workspace deps so the bundler can follow them
(cd "$ROOT" && pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null)

(cd "$ROOT" && bun build packages/cli/src/index.ts \
  --compile --minify \
  --target "bun-$TARGET" \
  --outfile "$OUTDIR/$BINARY_NAME")

# Smoke test (skip for cross-compiled targets that can't run here)
RUNNABLE="$(current_target)"
if [ "$RUNNABLE" = "$TARGET" ]; then
  echo "==> Smoke test"
  "$OUTDIR/$BINARY_NAME" --help >/dev/null || { echo "error: smoke test failed" >&2; exit 1; }
else
  echo "==> Skipping smoke test (cross-compiled $TARGET, running on $RUNNABLE)"
fi

# Package: binary + skills side by side (installer expects <prefix>/bin + <prefix>/skills)
STAGE="$OUTDIR/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/skills"
cp "$OUTDIR/$BINARY_NAME" "$STAGE/bin/"
cp -R "$ROOT/packages/resources/skills/." "$STAGE/skills/"

cd "$STAGE"
if [ "$TARGET" = "win-x64" ]; then
  ARTIFACT="$ROOT/dist-bin/tiny-cli-$VERSION-$TARGET.zip"
  command -v zip >/dev/null || { echo "error: 'zip' is required to package win-x64" >&2; exit 1; }
  zip -qr "$ARTIFACT" .
else
  ARTIFACT="$ROOT/dist-bin/tiny-cli-$VERSION-$TARGET.tar.gz"
  tar -czf "$ARTIFACT" bin skills
fi

echo "==> Done: $ARTIFACT"
