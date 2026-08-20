#!/bin/sh
# tiny-cli native installer (macOS/Linux). No Node.js required.
#
# Install latest release:  curl -fsSL <url>/install.sh | sh
# Install local tarball:  ./install.sh --file dist-bin/tiny-cli-<ver>-<target>.tar.gz
#                        (or: TINY_INSTALL_TARBALL=<path> ./install.sh)
set -eu

REPO="sadaigm/tiny-cli"
PREFIX="${TINY_INSTALL_PREFIX:-$HOME/.tiny-cli}"
LOCAL_TARBALL="${TINY_INSTALL_TARBALL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --file) LOCAL_TARBALL="$2"; shift 2 ;;
    --file=*) LOCAL_TARBALL="${1#*=}"; shift ;;
    *) echo "usage: install.sh [--file <tarball>]"; exit 1 ;;
  esac
done

[ -n "${FORCE_COLOR:-}" ] || export NO_COLOR=1

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- Detect platform -------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) die "unsupported OS '$OS'. Use install.ps1 on Windows." ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported architecture '$ARCH'" ;;
esac
TARGET="$OS-$ARCH"

command -v curl >/dev/null 2>&1 || die "curl is required but not found"
command -v tar >/dev/null 2>&1 || die "tar is required but not found"

# --- Get the tarball (local file or GitHub release) ------------------------
TMPDIR_INSTALL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_INSTALL"' EXIT

if [ -n "$LOCAL_TARBALL" ]; then
  [ -f "$LOCAL_TARBALL" ] || die "tarball not found: $LOCAL_TARBALL"
  say "Installing from local tarball $LOCAL_TARBALL"
  cp "$LOCAL_TARBALL" "$TMPDIR_INSTALL/tiny-cli.tar.gz"
else
  command -v grep >/dev/null 2>&1 || die "grep is required but not found"
  say "Resolving latest release"
  TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\(v[0-9][^"]*\)"$/\1/')"
  [ -n "$TAG" ] || die "could not resolve latest release (network or rate limit?)"
  VERSION="${TAG#v}"
  URL="https://github.com/$REPO/releases/download/$TAG/tiny-cli-$VERSION-$TARGET.tar.gz"
  say "Downloading $URL"
  curl -fSL --progress-bar -o "$TMPDIR_INSTALL/tiny-cli.tar.gz" "$URL" \
    || die "download failed (does a $TARGET build exist for $TAG?)"
fi

# --- Extract & install -----------------------------------------------------
say "Extracting"
mkdir -p "$TMPDIR_INSTALL/src"
tar -xzf "$TMPDIR_INSTALL/tiny-cli.tar.gz" -C "$TMPDIR_INSTALL/src"
[ -f "$TMPDIR_INSTALL/src/bin/tiny" ] || die "tarball has unexpected layout (expected bin/tiny)"

say "Installing to $PREFIX"
mkdir -p "$PREFIX"
# Backup an existing install so upgrades are safe
if [ -e "$PREFIX/bin/tiny" ]; then
  rm -rf "$PREFIX/bin.bak" "$PREFIX/skills.bak"
  mv "$PREFIX/bin" "$PREFIX/bin.bak"
  [ -d "$PREFIX/skills" ] && mv "$PREFIX/skills" "$PREFIX/skills.bak"
fi
rm -rf "$PREFIX/bin" "$PREFIX/skills"
cp -R "$TMPDIR_INSTALL/src/bin" "$PREFIX/bin"
cp -R "$TMPDIR_INSTALL/src/skills" "$PREFIX/skills"
chmod +x "$PREFIX/bin/tiny"

# --- PATH ------------------------------------------------------------------
BIN="$PREFIX/bin/tiny"
link_in() {
  if [ -d "$1" ] && case ":$PATH:" in *":$1:"*) true;; *) false;; esac; then
    ln -sf "$BIN" "$1/tiny" 2>/dev/null || return 1
    ln -sf "$BIN" "$1/tiny-cli" 2>/dev/null || true
    echo "$1/tiny"
    return 0
  fi
  return 1
}

LINKED=""
for d in "$HOME/.local/bin" /usr/local/bin "$HOME/bin"; do
  if LINKED="$(link_in "$d")"; then break; fi
done

if [ -z "$LINKED" ]; then
  case ":$PATH:" in *":$PREFIX/bin:"*) ;; *)
    SHELL_NAME="$(basename "${SHELL:-/bin/sh}")"
    RC="$HOME/.profile"
    [ "$SHELL_NAME" = "zsh" ] && [ -f "$HOME/.zshrc" ] && RC="$HOME/.zshrc"
    [ "$SHELL_NAME" = "bash" ] && [ -f "$HOME/.bashrc" ] && RC="$HOME/.bashrc"
    printf '\n# added by tiny-cli installer\nexport PATH="%s/bin:$PATH"\n' "$PREFIX" >> "$RC"
    say "Added $PREFIX/bin to PATH in $RC"
    say "Run: export PATH=\"$PREFIX/bin:\$PATH\"  (or restart your shell)"
    ;;
  esac
else
  say "Linked $LINKED"
fi

# --- Verify ----------------------------------------------------------------
say "Verifying"
NEWBIN="${LINKED:-$PREFIX/bin/tiny}"
if "$NEWBIN" --help >/dev/null 2>&1; then
  VERSION_OUT="$("$NEWBIN" --version 2>/dev/null || echo installed)" || true
  printf 'tiny installed successfully (%s) — command: tiny (alias: tiny-cli)\n' "$VERSION_OUT"
else
  die "installed binary failed to run: $NEWBIN"
fi
