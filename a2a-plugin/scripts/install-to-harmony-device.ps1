#Requires -Version 5.1
<#
.SYNOPSIS
  Install openclaw-a2a tarball onto a HarmonyOS OpenClaw device (bundled slot only).

.PARAMETER Serial
  hdc target serial (hdc list targets).

.PARAMETER Tarball
  Path to openclaw-a2a-*.tgz. Default: openclaw-a2a-1.4.3.tgz beside this script, else newest in repo root.

.PARAMETER Hdc
  Path to hdc.exe.

.PARAMETER SkipRestart
  Do not run start-openclaw.sh after install.
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Serial,

  [string]$Tarball = "",

  [string]$Hdc = "C:\Users\1\tools\hdc\hdc.exe",

  [switch]$SkipRestart
)

$ErrorActionPreference = "Stop"
$Here = $PSScriptRoot
$RepoRoot = Split-Path -Parent $Here

if (-not (Test-Path $Hdc)) {
  $cmd = Get-Command hdc -ErrorAction SilentlyContinue
  if ($cmd) { $Hdc = $cmd.Source }
  else { throw "hdc not found: $Hdc" }
}

# Device script: same folder (release layout) or scripts/ (repo layout)
$deviceScript = Join-Path $Here "install-harmony-bundled.sh"
if (-not (Test-Path $deviceScript)) {
  $deviceScript = Join-Path $Here "scripts\install-harmony-bundled.sh"
}
if (-not (Test-Path $deviceScript)) {
  $deviceScript = Join-Path $RepoRoot "scripts\install-harmony-bundled.sh"
}
if (-not (Test-Path $deviceScript)) {
  throw "Missing install-harmony-bundled.sh (looked beside this script and under scripts/)."
}

if (-not $Tarball) {
  $candidates = @()
  $candidates += Get-ChildItem -Path $Here -Filter "openclaw-a2a-*.tgz" -ErrorAction SilentlyContinue
  $candidates += Get-ChildItem -Path $RepoRoot -Filter "openclaw-a2a-*.tgz" -ErrorAction SilentlyContinue
  $Tarball = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Tarball -or -not (Test-Path $Tarball)) {
  throw "Tarball not found. Place openclaw-a2a-1.4.3.tgz beside this script, or pass -Tarball."
}
$Tarball = (Resolve-Path $Tarball).Path

Write-Host "Serial   : $Serial"
Write-Host "Tarball  : $Tarball"
Write-Host "Script   : $deviceScript"
Write-Host "Hdc      : $Hdc"

& $Hdc -t $Serial file send $Tarball /data/local/tmp/openclaw-a2a.tgz
if ($LASTEXITCODE -ne 0) { throw "failed to send tarball" }

& $Hdc -t $Serial file send $deviceScript /data/local/tmp/install-harmony-bundled.sh
if ($LASTEXITCODE -ne 0) { throw "failed to send install script" }

& $Hdc -t $Serial shell "sed -i 's/\r$//' /data/local/tmp/install-harmony-bundled.sh 2>/dev/null; TGZ=/data/local/tmp/openclaw-a2a.tgz /bin/sh /data/local/tmp/install-harmony-bundled.sh"
if ($LASTEXITCODE -ne 0) { throw "device install script failed" }

if (-not $SkipRestart) {
  Write-Host "Restarting OpenClaw..."
  & $Hdc -t $Serial shell "sh /data/local/tmp/start-openclaw.sh"
}

Write-Host "Done. Verify logs for a2a.registry.list and absence of duplicate a2a-gateway."
