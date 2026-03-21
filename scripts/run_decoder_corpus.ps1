[CmdletBinding()]
param (
    [string]$ReplayRoot = "replays",
    [string]$ApiRoot = "replays/api",
    [string]$ArtifactRoot = "artifacts",
    [string]$AnalyzerExe,
    [string]$BuildDir = "build",
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug",
    [int]$TopFamilies = 8,
    [int]$TopWindows = 16,
    [int]$TopFields = 16,
    [switch]$CleanReplayArtifacts,
    [switch]$SkipSchema,
    [switch]$SkipCorpusSchema,
    [switch]$SkipExtraction,
    [switch]$SkipValidation
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
$schemaScript = Join-Path $PSScriptRoot "build_provisional_schema.mjs"
$corpusSchemaScript = Join-Path $PSScriptRoot "build_corpus_schema.mjs"
$extractScript = Join-Path $PSScriptRoot "extract_replay_stats.mjs"
$validateScript = Join-Path $PSScriptRoot "validate_extracted_stats.mjs"

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

    Write-Host "Generating decoder artifacts for $($replayFile.Name)" -ForegroundColor Cyan
    & $artifactScript `
        -ReplayPath $replayFile.FullName `
        -ArtifactRoot $resolvedArtifactRoot `
        -AnalyzerExe $AnalyzerExe `
        -BuildDir $BuildDir `
        -Configuration $Configuration `
        -TopFamilies $TopFamilies `
        -TopWindows $TopWindows `
        -TopFields $TopFields `
        -Clean:$CleanReplayArtifacts

    if ($LASTEXITCODE -ne 0) {
        throw "Artifact generation failed for $($replayFile.FullName)"
    }

    $artifactDir = Join-Path $resolvedArtifactRoot $replayFile.BaseName
    if (-not $SkipSchema) {
        Write-Host "Building provisional schema for $($replayFile.Name)" -ForegroundColor Cyan
        node $schemaScript --artifact-dir $artifactDir --fixture-dir $fixtureDir
        if ($LASTEXITCODE -ne 0) {
            throw "Provisional schema generation failed for $($replayFile.FullName)"
        }
    }

    $processed += [ordered]@{
        replayName = $replayFile.Name
        replayId = $replayFile.BaseName
        artifactDir = $artifactDir
        fixtureDir = $fixtureDir
    }
}

$manifest = [ordered]@{
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    replayRoot = $resolvedReplayRoot
    apiRoot = $resolvedApiRoot
    artifactRoot = $resolvedArtifactRoot
    processed = $processed
}

$manifestPath = Join-Path $resolvedArtifactRoot "corpus-manifest.json"
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding utf8
$corpusSchemaPath = Join-Path $resolvedArtifactRoot "corpus-schema.json"

if (-not $SkipCorpusSchema) {
    Write-Host "Building cross-replay corpus schema" -ForegroundColor Cyan
    node $corpusSchemaScript --artifact-root $resolvedArtifactRoot --corpus-manifest $manifestPath --output-path $corpusSchemaPath
    if ($LASTEXITCODE -ne 0) {
        throw "Corpus schema generation failed."
    }
    $manifest.corpusSchemaPath = $corpusSchemaPath
}

if (-not $SkipExtraction) {
    if ($SkipCorpusSchema -and -not (Test-Path $corpusSchemaPath)) {
        throw "Replay-only extraction requires corpus schema at $corpusSchemaPath"
    }

    foreach ($entry in $processed) {
        $extractedPath = Join-Path $entry.artifactDir "extracted-stats.json"
        Write-Host "Extracting replay-only stats for $($entry.replayName)" -ForegroundColor Cyan
        node $extractScript --artifact-dir $entry.artifactDir --schema-path $corpusSchemaPath --output-path $extractedPath
        if ($LASTEXITCODE -ne 0) {
            throw "Replay-only extraction failed for $($entry.replayName)"
        }
        $entry["extractedStatsPath"] = $extractedPath
    }
}

if (-not $SkipValidation) {
    foreach ($entry in $processed) {
        $extractedPath = if ($entry.Contains("extractedStatsPath")) { $entry.extractedStatsPath } else { Join-Path $entry.artifactDir "extracted-stats.json" }
        if (-not (Test-Path $extractedPath)) {
            throw "Validation requires extracted stats at $extractedPath"
        }

        $validationPath = Join-Path $entry.artifactDir "validation-report.json"
        Write-Host "Validating extracted stats for $($entry.replayName)" -ForegroundColor Cyan
        node $validateScript --extracted-path $extractedPath --fixture-dir $entry.fixtureDir --output-path $validationPath
        if ($LASTEXITCODE -ne 0) {
            throw "Validation failed for $($entry.replayName)"
        }
        $entry["validationReportPath"] = $validationPath
    }
}

$manifest.generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
$manifest.processed = $processed
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Path $manifestPath -Encoding utf8

Write-Host "Wrote corpus manifest to $manifestPath" -ForegroundColor Green
