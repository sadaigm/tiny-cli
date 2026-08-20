# tiny-cli native installer for Windows (PowerShell). No Node.js required.
#
# Install latest release:  irm <url>/install.ps1 | iex
# Install local zip:      .\install.ps1 -File dist-bin\tiny-cli-<ver>-win-x64.zip
param(
  [string]$File = $env:TINY_INSTALL_TARBALL
)

$ErrorActionPreference = 'Stop'
$Repo = 'sadaigm/tiny-cli'
$Prefix = if ($env:TINY_INSTALL_PREFIX) { $env:TINY_INSTALL_PREFIX } else { Join-Path $env:USERPROFILE '.tiny-cli' }

function Say($msg) { Write-Host "==> $msg" }
function Die($msg) { Write-Error $msg; exit 1 }

# --- Detect platform -------------------------------------------------------
$OSArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($OSArch -ne [System.Runtime.InteropServices.Architecture]::X64) {
  Die "unsupported architecture '$OSArch' (only win-x64 builds are published)"
}
$Target = 'win-x64'

# --- Get the zip (local file or GitHub release) ----------------------------
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("tiny-cli-install-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $TempDir | Out-Null
try {
  $ZipPath = Join-Path $TempDir 'tiny-cli.zip'
  if ($File) {
    if (-not (Test-Path $File)) { Die "zip not found: $File" }
    Say "Installing from local zip $File"
    Copy-Item $File $ZipPath
  } else {
    Say "Resolving latest release"
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    $Tag = $Release.tag_name
    $Version = $Tag.TrimStart('v')
    $Asset = $Release.assets | Where-Object { $_.name -eq "tiny-cli-$Version-$Target.zip" } | Select-Object -First 1
    if (-not $Asset) { Die "no $Target asset found on release $Tag" }
    Say "Downloading $($Asset.name)"
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $ZipPath
  }

  # --- Extract & install ---------------------------------------------------
  Say "Extracting"
  $SrcDir = Join-Path $TempDir 'src'
  Expand-Archive -Path $ZipPath -DestinationPath $SrcDir
  $Exe = Join-Path $SrcDir 'bin\tiny.exe'
  if (-not (Test-Path $Exe)) { Die "zip has unexpected layout (expected bin\tiny.exe)" }

  Say "Installing to $Prefix"
  New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
  # Backup an existing install so upgrades are safe
  if (Test-Path (Join-Path $Prefix 'bin')) {
    if (Test-Path (Join-Path $Prefix 'bin.bak')) { Remove-Item -Recurse -Force (Join-Path $Prefix 'bin.bak'), (Join-Path $Prefix 'skills.bak') -ErrorAction SilentlyContinue }
    Move-Item (Join-Path $Prefix 'bin') (Join-Path $Prefix 'bin.bak')
    if (Test-Path (Join-Path $Prefix 'skills')) { Move-Item (Join-Path $Prefix 'skills') (Join-Path $Prefix 'skills.bak') }
  }
  if (Test-Path (Join-Path $Prefix 'bin')) { Remove-Item -Recurse -Force (Join-Path $Prefix 'bin') }
  if (Test-Path (Join-Path $Prefix 'skills')) { Remove-Item -Recurse -Force (Join-Path $Prefix 'skills') }
  Move-Item (Join-Path $SrcDir 'bin') (Join-Path $Prefix 'bin')
  Move-Item (Join-Path $SrcDir 'skills') (Join-Path $Prefix 'skills')
  Copy-Item (Join-Path $Prefix 'bin\tiny.exe') (Join-Path $Prefix 'bin\tiny-cli.exe')

  # --- PATH ----------------------------------------------------------------
  $BinDir = Join-Path $Prefix 'bin'
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($UserPath -notlike "*$BinDir*") {
    Say "Adding $BinDir to user PATH"
    [Environment]::SetEnvironmentVariable('Path', "$UserPath;$BinDir", 'User')
  }

  # --- Verify --------------------------------------------------------------
  Say "Verifying"
  $Installed = Join-Path $BinDir "tiny.exe"
  & $Installed --help | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "installed binary failed to run: $Installed" }
  Write-Host "tiny installed successfully. Open a new terminal and run: tiny (alias: tiny-cli)"
} finally {
  Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}
