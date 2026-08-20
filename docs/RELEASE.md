# tiny-cli Release Guide

How to build and release tiny-cli. Refer to this doc every time you cut a release.

## Overview

Distribution channels:

| Channel | Command | Requires Node? |
|---|---|---|
| Native installer (primary) | `curl -fsSL <url>/install.sh \| sh` (macOS/Linux), `irm <url>/install.ps1 \| iex` (Windows) | No — self-contained binary |
| npm (secondary) | `npm i -g tiny-cli` | Yes (≥ 20) |

The native binary is compiled with [Bun](https://bun.sh) (`--compile`) — it bundles
the Bun runtime + all JS dependencies into a single executable. Users get **both**
commands: `tiny` (primary) and `tiny-cli` (alias).

Install layout (native):

```
~/.tiny-cli/                 # Windows: %USERPROFILE%\.tiny-cli
├── bin/tiny                 # the binary
├── bin/tiny-cli             # symlink (sh) / copy (ps1)
└── skills/                  # bundled skills (create-skill, ...)
```

## Local build & test (no GitHub involved)

Prereq: Bun installed (`curl -fsSL https://bun.sh/install | bash`).

```bash
# Build for the current machine (e.g. linux-x64)
scripts/build-binary.sh

# Or cross-compile a specific target
scripts/build-binary.sh darwin-arm64
# Targets: linux-x64 linux-arm64 darwin-x64 darwin-arm64 win-x64
```

Output: `dist-bin/tiny-cli-<version>-<target>.tar.gz` (`.zip` for win-x64),
containing `bin/tiny` + `skills/`. The script smoke-tests `--help` on native builds.

### Test the installer against a local tarball

```bash
# Install into a throwaway prefix to avoid touching your real install
TINY_INSTALL_PREFIX=/tmp/tiny-test ./scripts/install.sh --file dist-bin/tiny-cli-<ver>-<target>.tar.gz

/tmp/tiny-test/bin/tiny --version

# Windows (on a Windows box):
# .\scripts\install.ps1 -File dist-bin\tiny-cli-<ver>-win-x64.zip
```

Clean up: `rm -rf /tmp/tiny-test ~/.local/bin/tiny ~/.local/bin/tiny-cli`

The `--file` / `-File` flag swaps only the download step for a local tarball —
extract, install layout, symlinks, PATH, and verification all run identically.

## Cutting a release (GitHub)

1. **Bump the version** in `packages/cli/package.json` (single source; the build
   script reads it for artifact names — keep `packages/core` / `packages/resources`
   in sync if you publish them to npm).

2. **Commit and push everything to the default branch** — the CI checkout uses the
   repo, not your working tree. Nothing release-related runs from local files.

3. **Tag and push the tag**:

   ```bash
   git tag v1.0.0          # must match v* — the workflow trigger
   git push origin v1.0.0
   ```

4. **Watch GitHub → Actions → "release"**. The matrix builds all 5 targets with
   Bun cross-compilation on an Ubuntu runner, smoke-tests the native one, and
   `softprops/action-gh-release` creates the Release and attaches the artifacts.

5. **Verify the release page** shows:
   - `tiny-cli-<ver>-linux-x64.tar.gz`
   - `tiny-cli-<ver>-linux-arm64.tar.gz`
   - `tiny-cli-<ver>-darwin-x64.tar.gz`
   - `tiny-cli-<ver>-darwin-arm64.tar.gz`
   - `tiny-cli-<ver>-win-x64.zip`

6. **Test the real installer** (no `--file`):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/sadaigm/tiny-cli/main/scripts/install.sh | sh
   tiny --version
   ```

## Install URLs (public)

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/sadaigm/tiny-cli/main/scripts/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/sadaigm/tiny-cli/main/scripts/install.ps1 | iex
```

(The README documents these; a short domain / GitHub Pages can replace the raw
URLs later without changing the scripts' repo slug.)

## Notes & gotchas

- **Cross-compile caveat**: darwin/win targets are Bun cross-compiled from Linux
  and are not smoke-tested in CI (can't run). If a target breaks, the fallback is
  a `runs-on: macos-latest` job for that target.
- **`react-devtools-core`** is a real dependency of `packages/cli` because ink
  imports it at startup; removing it breaks the compiled binary.
- **Skills resolution**: `packages/resources/src/discover.ts` first tries the
  package-relative `skills/` dir (npm installs), then falls back to
  `<execpath>/../skills` (native binary layout). Release tarballs must always
  include the `skills/` dir next to `bin/`.
- **Upgrades**: install.sh/ps1 move the previous install to `bin.bak`/`skills.bak`
  before installing — re-running the installer is a safe upgrade path.
- **npm publish** (when you get to it): `pnpm -r publish --access public` from a
  clean build; pnpm rewrites `workspace:*` versions automatically.

## Release checklist

- [ ] Version bumped in `packages/cli/package.json`
- [ ] `pnpm build` and tests pass locally
- [ ] Local tarball built and installer tested with `--file`
- [ ] All changes committed & pushed to default branch
- [ ] Tag `v*` pushed
- [ ] Actions run green; release has all 5 artifacts
- [ ] Plain `curl | sh` installer verified against the release
