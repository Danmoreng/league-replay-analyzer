[CmdletBinding()]
param (
    [switch]$Clean,
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",
    [string]$BuildDir = "build-wasm",
    [string]$EmsdkRoot = "tools/emsdk"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedBuildDir = Join-Path $repoRoot $BuildDir
$resolvedEmsdkRoot = Join-Path $repoRoot $EmsdkRoot

if (-not (Get-Command emcmake -ErrorAction SilentlyContinue)) {
    $envScript = Join-Path $resolvedEmsdkRoot "emsdk_env.ps1"
    if (Test-Path $envScript) {
        & $envScript | Out-Null
    }
}

if (-not (Get-Command emcmake -ErrorAction SilentlyContinue)) {
    throw "emcmake was not found on PATH. Install and activate emsdk before building Wasm."
}

if ($Clean -and (Test-Path $resolvedBuildDir)) {
    Remove-Item -Recurse -Force $resolvedBuildDir
}

if (-not (Test-Path $resolvedBuildDir)) {
    New-Item -ItemType Directory $resolvedBuildDir | Out-Null
}

Push-Location $repoRoot
try {
    emcmake cmake -S . -B $resolvedBuildDir -DROFL_BUILD_WASM=ON -DCMAKE_BUILD_TYPE=$Configuration
    cmake --build $resolvedBuildDir --config $Configuration --target rofl_wasm
} finally {
    Pop-Location
}
