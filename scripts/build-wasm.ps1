[CmdletBinding()]
param (
    [switch]$Clean,
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",
    [string]$BuildDir = "build-wasm",
    [string]$EmsdkRoot = "tools/emsdk",
    [string]$PublishDir = "apps/web/src/generated/wasm"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedBuildDir = Join-Path $repoRoot $BuildDir
$resolvedEmsdkRoot = Join-Path $repoRoot $EmsdkRoot
$resolvedPublishDir = Join-Path $repoRoot $PublishDir

$envScript = Join-Path $resolvedEmsdkRoot "emsdk_env.ps1"
if (Test-Path $envScript) {
    & $envScript | Out-Null
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
    $configureArgs = @(
        "cmake",
        "-S",
        ".",
        "-B",
        $resolvedBuildDir,
        "-DROFL_BUILD_WASM=ON",
        "-DCMAKE_BUILD_TYPE=$Configuration"
    )
    emcmake @configureArgs
    cmake --build $resolvedBuildDir --config $Configuration --target rofl_wasm

    if ($PublishDir) {
        $wasmBuildDir = Join-Path $resolvedBuildDir "packages/rofl-wasm"
        $jsSource = Join-Path $wasmBuildDir "rofl_wasm.js"
        $wasmSource = Join-Path $wasmBuildDir "rofl_wasm.wasm"

        if (-not (Test-Path $jsSource) -or -not (Test-Path $wasmSource)) {
            throw "Expected Wasm artifacts were not produced in $wasmBuildDir"
        }

        New-Item -ItemType Directory -Force $resolvedPublishDir | Out-Null
        Copy-Item $jsSource $resolvedPublishDir -Force
        Copy-Item $wasmSource $resolvedPublishDir -Force
        Write-Host "Published Wasm artifacts to $resolvedPublishDir" -ForegroundColor Green
    }
} finally {
    Pop-Location
}

