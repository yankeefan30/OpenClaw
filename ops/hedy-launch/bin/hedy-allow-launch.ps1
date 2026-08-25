# Unblock Hedy on Windows. Not OpenClaw. Defender exclusions only.
# Requires an elevated PowerShell. Does not disable real-time scanning.

[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Assert-HedyPath([string]$Path) {
    if (-not $Path) { return $false }
    $leaf = Split-Path -Leaf $Path
    return $leaf -match '(?i)hedy'
}

$localHedy = Join-Path $env:LOCALAPPDATA "Hedy"
$programHedy = Join-Path $env:LOCALAPPDATA "Programs\Hedy"
$pfHedy = Join-Path ${env:ProgramFiles} "Hedy"
$desktop = [Environment]::GetFolderPath("Desktop")
$downloads = Join-Path $env:USERPROFILE "Downloads"

$exclusions = @(
    $localHedy,
    $programHedy,
    $pfHedy
) | Where-Object { Assert-HedyPath $_ }

$setupCandidates = @()
foreach ($root in @($downloads, $desktop, $env:USERPROFILE)) {
    if (Test-Path $root) {
        $setupCandidates += Get-ChildItem -Path $root -Filter "HedySetup-*.exe" -ErrorAction SilentlyContinue
        $setupCandidates += Get-ChildItem -Path $root -Filter "Hedy.exe" -ErrorAction SilentlyContinue
    }
}

Write-Host "hedy-allow-launch: Windows Defender Hedy exclusions"

if ($DryRun) {
    foreach ($path in $exclusions) {
        Write-Host "hedy-allow-launch: dry-run would-exclude-path $path"
    }
    Write-Host "hedy-allow-launch: dry-run would-exclude-process Hedy.exe"
    foreach ($file in $setupCandidates) {
        Write-Host "hedy-allow-launch: dry-run would-unblock $($file.FullName)"
    }
    exit 0
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "hedy-allow-launch: run this from an elevated PowerShell."
}

foreach ($path in $exclusions) {
    Write-Host "hedy-allow-launch: excluding path $path"
    Add-MpPreference -ExclusionPath $path -ErrorAction SilentlyContinue
}

Write-Host "hedy-allow-launch: excluding process Hedy.exe"
Add-MpPreference -ExclusionProcess "Hedy.exe" -ErrorAction SilentlyContinue
Add-MpPreference -ExclusionProcess "HedySetup.exe" -ErrorAction SilentlyContinue

try {
    $threats = Get-MpThreatDetection | Where-Object {
        $_.Resources -match '(?i)hedy'
    }
    foreach ($threat in $threats) {
        Write-Host "hedy-allow-launch: removing Defender threat id $($threat.ThreatID)"
        Remove-MpThreat -ThreatID $threat.ThreatID -ErrorAction SilentlyContinue
    }
} catch {
    Write-Host "hedy-allow-launch: no Defender threat cmdlets available; skip quarantine restore"
}

foreach ($file in $setupCandidates | Select-Object -Unique) {
    if (Assert-HedyPath $file.FullName) {
        Write-Host "hedy-allow-launch: unblocking $($file.FullName)"
        Unblock-File -Path $file.FullName -ErrorAction SilentlyContinue
    }
}

Write-Host "hedy-allow-launch: done. Launch Hedy from the Start menu."
Write-Host "If SmartScreen still blocks it, choose More info → Run anyway on the official installer."
