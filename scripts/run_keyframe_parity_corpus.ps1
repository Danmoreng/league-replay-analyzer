[CmdletBinding()]
param (
    [string]$ReplayRoot = "replays",
    [string]$ApiRoot = "replays/api",
    [string]$ArtifactRoot = "artifacts-keyframes",
    [string]$AnalyzerExe,
    [string]$BuildDir = "build",
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug",
    [int]$TopFamilies = 12,
    [int]$TopEntitySlots = 32,
    [int]$TopScalarSlots = 24,
    [int]$DynamicSlotCount = 12,
    [int]$MixedSlotCount = 4,
    [int]$HandleSlotCount = 0,
    [int]$TopWindows = 24,
    [int]$TopFields = 24,
    [switch]$Force,
    [switch]$CleanReplayArtifacts,
    [switch]$SkipArtifacts,
    [switch]$SkipParity,
    [switch]$SkipSchema
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-AbsolutePath {
    param(
        [string]$Path,
        [string]$BasePath
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }

    return [System.IO.Path]::GetFullPath((Join-Path $BasePath $Path))
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedReplayRoot = Resolve-AbsolutePath -Path $ReplayRoot -BasePath $repoRoot
$resolvedApiRoot = Resolve-AbsolutePath -Path $ApiRoot -BasePath $repoRoot
$resolvedArtifactRoot = Resolve-AbsolutePath -Path $ArtifactRoot -BasePath $repoRoot

$artifactScript = Join-Path $PSScriptRoot "run_decoder_artifacts.ps1"
$parityScript = Join-Path $PSScriptRoot "discover_keyframe_api_parity.mjs"
$schemaScript = Join-Path $PSScriptRoot "build_keyframe_parity_schema.mjs"

if (-not (Test-Path $resolvedArtifactRoot)) {
    New-Item -ItemType Directory -Path $resolvedArtifactRoot -Force | Out-Null
}

$replayFiles = Get-ChildItem -Path $resolvedReplayRoot -Filter "*.rofl" -File | Sort-Object Name
if ($replayFiles.Count -eq 0) {
    throw "No .rofl files found under $resolvedReplayRoot"
}

$processed = @()
foreach ($replayFile in $replayFiles) {
    $matchId = $replayFile.BaseName -replace "-", "_"
    $fixtureDir = Join-Path $resolvedApiRoot $matchId
    if (-not (Test-Path (Join-Path $fixtureDir "match.json")) -or -not (Test-Path (Join-Path $fixtureDir "timeline.json"))) {
        Write-Host "Skipping $($replayFile.Name) because fixture bundle is missing under $fixtureDir" -ForegroundColor Yellow
        continue
    }

    if (-not $SkipArtifacts) {
        Write-Host "Generating keyframe artifacts for $($replayFile.Name)" -ForegroundColor Cyan
        & $artifactScript `
            -ReplayPath $replayFile.FullName `
            -ArtifactRoot $resolvedArtifactRoot `
            -AnalyzerExe $AnalyzerExe `
            -BuildDir $BuildDir `
            -Configuration $Configuration `
            -MinLength 4096 `
            -MinRecords 2 `
            -TopFamilies $TopFamilies `
            -TopEntitySlots $TopEntitySlots `
            -TopScalarSlots $TopScalarSlots `
            -DynamicSlotCount $DynamicSlotCount `
            -MixedSlotCount $MixedSlotCount `
            -HandleSlotCount $HandleSlotCount `
            -TopWindows $TopWindows `
            -TopFields $TopFields `
            -RecordType keyframe `
            -SkipScalar `
            -Force:$Force `
            -Clean:$CleanReplayArtifacts

        if (-not $?) {
            throw "Keyframe artifact generation failed for $($replayFile.FullName)"
        }
    }

    $artifactDir = Join-Path $resolvedArtifactRoot $replayFile.BaseName
    if (Test-Path (Join-Path $artifactDir "run-manifest.json")) {
        $processed += [ordered]@{
            replayName = $replayFile.Name
            replayId = $replayFile.BaseName
            artifactDir = $artifactDir
            fixtureDir = $fixtureDir
        }
    }
}

$manifest = [ordered]@{
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    replayRoot = $resolvedReplayRoot
    apiRoot = $resolvedApiRoot
    artifactRoot = $resolvedArtifactRoot
    recordType = "keyframe"
    processed = $processed
}
$manifestPath = Join-Path $resolvedArtifactRoot "keyframe-corpus-manifest.json"
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Path $manifestPath -Encoding utf8

$parityReportPath = Join-Path $resolvedArtifactRoot "keyframe-api-parity.json"
if (-not $SkipParity) {
    Write-Host "Discovering keyframe/API parity across $($processed.Count) replay(s)" -ForegroundColor Cyan
    node $parityScript --artifact-root $resolvedArtifactRoot --api-root $resolvedApiRoot --output-path $parityReportPath
    if ($LASTEXITCODE -ne 0) {
        throw "Keyframe/API parity discovery failed."
    }
    $manifest["keyframeApiParityPath"] = $parityReportPath
}

$schemaPath = Join-Path $resolvedArtifactRoot "keyframe-parity-schema.json"
if (-not $SkipSchema) {
    Write-Host "Building keyframe parity schema" -ForegroundColor Cyan
    node $schemaScript --artifact-root $resolvedArtifactRoot --parity-report $parityReportPath --output-path $schemaPath
    if ($LASTEXITCODE -ne 0) {
        throw "Keyframe parity schema generation failed."
    }
    $manifest["keyframeParitySchemaPath"] = $schemaPath
}

$manifest.generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Path $manifestPath -Encoding utf8
Write-Host "Wrote keyframe corpus manifest to $manifestPath" -ForegroundColor Green
