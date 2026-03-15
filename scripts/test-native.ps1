[CmdletBinding()]
param (
    [switch]$Clean,
    [switch]$UseNinja,
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug",
    [string]$BuildDir = "build"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$buildScript = Join-Path $PSScriptRoot "build-native.ps1"
$resolvedBuildDir = Join-Path $repoRoot $BuildDir

Write-Host "Building native test target..." -ForegroundColor Cyan
& $buildScript `
    -Clean:$Clean `
    -UseNinja:$UseNinja `
    -Configuration $Configuration `
    -BuildDir $BuildDir `
    -Target "rofl_core_tests"

Write-Host "Running native tests..." -ForegroundColor Cyan
ctest --test-dir $resolvedBuildDir --output-on-failure --build-config $Configuration
