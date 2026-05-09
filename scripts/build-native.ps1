[CmdletBinding()]
param (
    [switch]$Clean,
    [switch]$UseNinja,
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug",
    [string]$BuildDir = "build",
    [string]$Target = "rofl_core_cli",
    [switch]$RunSmokeTest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Import-VSEnv {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) {
        throw "vswhere.exe not found. Visual Studio might not be installed."
    }

    $installationPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $installationPath) {
        throw "Visual Studio with C++ tools not found."
    }

    $vcvars = Join-Path $installationPath "VC\Auxiliary\Build\vcvars64.bat"
    if (-not (Test-Path $vcvars)) {
        throw "vcvars64.bat not found at $vcvars"
    }

    Write-Host "Importing MSVC environment..." -ForegroundColor Cyan
    $tempFile = [IO.Path]::GetTempFileName()
    cmd /c "`"$vcvars`" && set > `"$tempFile`""
    Get-Content $tempFile | ForEach-Object {
        if ($_ -match "^(.*?)=(.*)$") {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
    Remove-Item $tempFile
}

function Get-ConfiguredGenerator {
    param([string]$Dir)

    $cacheFile = Join-Path $Dir "CMakeCache.txt"
    if (Test-Path $cacheFile) {
        $line = Get-Content $cacheFile | Select-String "CMAKE_GENERATOR:INTERNAL="
        if ($line -match "=(.*)$") {
            return $matches[1]
        }
    }

    return $null
}

function Resolve-BuiltExecutable {
    param(
        [string]$Dir,
        [string]$Name
    )

    $match = Get-ChildItem -Path $Dir -Recurse -Filter "$Name.exe" -File | Select-Object -First 1
    if ($match) {
        return $match.FullName
    }

    return Join-Path $Dir "$Name.exe"
}

function Assert-LastExitCode {
    param([string]$Step)

    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedBuildDir = Join-Path $repoRoot $BuildDir

if ($Clean -and (Test-Path $resolvedBuildDir)) {
    Write-Host "Cleaning build directory..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $resolvedBuildDir
}

if (-not (Test-Path $resolvedBuildDir)) {
    New-Item -ItemType Directory $resolvedBuildDir | Out-Null
}

if (-not $env:VCINSTALLDIR) {
    Import-VSEnv
}

if ($UseNinja -and -not (Get-Command ninja -ErrorAction SilentlyContinue)) {
    throw "Ninja was requested with -UseNinja but was not found on PATH."
}

$generator = if ($UseNinja) { "Ninja" } else { "Visual Studio 17 2022" }
$currentGenerator = Get-ConfiguredGenerator $resolvedBuildDir

if ($currentGenerator -and $currentGenerator -ne $generator) {
    Write-Host "Generator mismatch (found $currentGenerator, requested $generator). Cleaning build directory..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $resolvedBuildDir
    New-Item -ItemType Directory $resolvedBuildDir | Out-Null
}

Write-Host "Configuring CMake with $generator..." -ForegroundColor Cyan
$configureArgs = @("-S", $repoRoot, "-B", $resolvedBuildDir, "-G", $generator)
if ($generator -eq "Ninja") {
    $configureArgs += "-DCMAKE_BUILD_TYPE=$Configuration"
}
cmake @configureArgs
Assert-LastExitCode "CMake configure"

Write-Host "Building target $Target ($Configuration)..." -ForegroundColor Cyan
cmake --build $resolvedBuildDir --config $Configuration --target $Target
Assert-LastExitCode "CMake build"

if ($RunSmokeTest) {
    $exePath = Resolve-BuiltExecutable -Dir $resolvedBuildDir -Name $Target

    if (-not (Test-Path $exePath)) {
        throw "Executable not found at $exePath"
    }

    Write-Host "Running smoke test..." -ForegroundColor Cyan
    & $exePath --version
    Assert-LastExitCode "Smoke test"
}
