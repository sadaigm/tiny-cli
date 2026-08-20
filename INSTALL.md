# Installing tiny-cli

There are two ways to install **tiny-cli** — a native installer (recommended,
no Node.js needed) and npm. After installation you can use both `tiny` and
`tiny-cli` commands — they are aliases for the same tool.

> **Requirements for the native installer:** a 64-bit macOS, Linux, or Windows
> system with `curl` (macOS/Linux) or PowerShell (Windows). That's it — the
> binary is self-contained.

---

## Native installer (recommended)

### macOS & Linux

Open a terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/sadaigm/tiny-cli/main/scripts/install.sh | sh
```

### Windows (PowerShell)

Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/sadaigm/tiny-cli/main/scripts/install.ps1 | iex
```

Then open a **new terminal** and run:

```
tiny
```

### What the installer does

- Detects your OS and architecture (linux-x64/arm64, darwin-x64/arm64, win-x64)
- Downloads the matching self-contained binary from the
  [latest release](https://github.com/sadaigm/tiny-cli/releases)
- Installs to `~/.tiny-cli/` (Windows: `%USERPROFILE%\.tiny-cli`):

  ```
  ~/.tiny-cli/
  ├── bin/tiny          # the binary
  ├── bin/tiny-cli      # alias
  └── skills/           # bundled skills
  ```

- Puts `tiny` on your PATH (symlink in `/usr/local/bin` or `~/.local/bin`,
  or a PATH entry in your shell profile)
- Verifies the binary runs before reporting success

### Upgrading

Run the installer again — it backs up your previous install to `bin.bak` /
`skills.bak` first, so upgrading (and rolling back) is safe.

### Uninstalling

```bash
rm -rf ~/.tiny-cli ~/.local/bin/tiny ~/.local/bin/tiny-cli
```

Remove the `# added by tiny-cli installer` line from your shell profile
(`~/.bashrc` / `~/.zshrc` / `~/.profile`) if one was added.

Windows (PowerShell):

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.tiny-cli"
```

---

## Install via npm

Requires [Node.js](https://nodejs.org) ≥ 20.

```bash
npm install -g tiny-cli
```

Or with your preferred package manager:

```bash
pnpm install -g tiny-cli
# or
bun install -g tiny-cli
```

### Upgrading / uninstalling (npm)

```bash
npm update -g tiny-cli
npm uninstall -g tiny-cli
```

---

## Install a specific version (native)

```bash
# e.g. install the v0.0.1-beta prerelease instead of latest
curl -fsSL https://github.com/sadaigm/tiny-cli/releases/download/v0.0.1-beta/tiny-cli-1.0.0-linux-x64.tar.gz -o /tmp/tiny.tar.gz
sh scripts/install.sh --file /tmp/tiny.tar.gz
```

Or download any asset directly from the
[releases page](https://github.com/sadaigm/tiny-cli/releases), extract it, and
add its `bin/` directory to your PATH.

---

## Verify your installation

```bash
tiny --version
tiny --help
```

If `tiny` isn't found after install, open a new terminal (PATH changes only
apply to new sessions) or see the PATH note the installer printed.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `tiny: command not found` | Open a new terminal; if still missing, ensure `~/.tiny-cli/bin` (or npm's global bin dir) is on your PATH |
| Download 404 | Your OS/arch may not have a build yet (currently: linux-x64/arm64, darwin-x64/arm64, win-x64) — open an issue |
| `curl: command not found` | Install curl (macOS/Linux package manager) or use the npm method |
| Behind a proxy | Ensure `HTTPS_PROXY` is set; both installers honor standard proxy env vars |
| Windows: script blocked | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` first, or use the npm method |

Questions or problems? [Open an issue](https://github.com/sadaigm/tiny-cli/issues).
