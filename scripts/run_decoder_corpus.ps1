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
    [switch]$Force,
    [switch]$CleanReplayArtifacts,
    [switch]$SkipSchema,
    [switch]$SkipCorpusSchema,
    [switch]$SkipExtraction,
    [switch]$SkipValidation,
    [switch]$SkipMovement
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

function Get-LatestWriteTimeUtc {
    param([string[]]$Paths)

    $latest = [DateTime]::MinValue
    foreach ($path in $Paths) {
        if (-not $path) {
            continue
        }

        if (-not (Test-Path -LiteralPath $path)) {
            return $null
        }

        $candidate = (Get-Item -LiteralPath $path).LastWriteTimeUtc
        if ($candidate -gt $latest) {
            $latest = $candidate
        }
    }

    return $latest
}

function Test-OutputsFresh {
    param(
        [string[]]$OutputPaths,
        [string[]]$InputPaths
    )

    if ($Force -or -not $OutputPaths -or $OutputPaths.Count -eq 0) {
        return $false
    }

    $latestInput = Get-LatestWriteTimeUtc -Paths $InputPaths
    if ($null -eq $latestInput) {
        return $false
    }

    foreach ($outputPath in $OutputPaths) {
        if (-not $outputPath -or -not (Test-Path -LiteralPath $outputPath)) {
            return $false
        }

        $outputTime = (Get-Item -LiteralPath $outputPath).LastWriteTimeUtc
        if ($outputTime -lt $latestInput) {
            return $false
        }
    }

    return $true
}

function Get-CorpusSchemaInputs {
    param(
        [object[]]$Entries,
        [string]$SchemaScriptPath,
        [switch]$IncludeValidation
    )

    $inputs = @($SchemaScriptPath)
    foreach ($entry in $Entries) {
        $inputs += @(
            (Join-Path $entry.artifactDir "run-manifest.json"),
            (Join-Path $entry.artifactDir "provisional-schema.json"),
            (Join-Path $entry.artifactDir "candidate-matches.json")
        )

        if ($IncludeValidation) {
            $inputs += @(
                (Join-Path $entry.artifactDir "extracted-stats.json"),
                (Join-Path $entry.artifactDir "validation-report.json")
            )
        }
    }

    return $inputs
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
$discoverMovementScript = Join-Path $PSScriptRoot "discover_movement_candidates.mjs"
$extractMovementScript = Join-Path $PSScriptRoot "extract_replay_movement.mjs"
$validateMovementScript = Join-Path $PSScriptRoot "validate_movement_candidates.mjs"
$movementIdentityPriorsScript = Join-Path $PSScriptRoot "build_movement_identity_priors.mjs"
$movementCoordinateModelScript = Join-Path $PSScriptRoot "build_movement_coordinate_model.mjs"
$assignMovementScript = Join-Path $PSScriptRoot "assign_replay_movement.mjs"
$validateAssignedMovementScript = Join-Path $PSScriptRoot "validate_assigned_movement.mjs"

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
        -Force:$Force `
        -Clean:$CleanReplayArtifacts

    if (-not $?) {
        throw "Artifact generation failed for $($replayFile.FullName)"
    }

    $artifactDir = Join-Path $resolvedArtifactRoot $replayFile.BaseName
    if (-not $SkipSchema) {
        $provisionalSchemaPath = Join-Path $artifactDir "provisional-schema.json"
        $candidateMatchesPath = Join-Path $artifactDir "candidate-matches.json"
        $schemaOutputs = @($provisionalSchemaPath, $candidateMatchesPath)
        $schemaInputs = @(
            (Join-Path $artifactDir "run-manifest.json"),
            (Join-Path $fixtureDir "match.json"),
            (Join-Path $fixtureDir "timeline.json"),
            $schemaScript
        )

        if (Test-OutputsFresh -OutputPaths $schemaOutputs -InputPaths $schemaInputs) {
            Write-Host "Reusing provisional schema for $($replayFile.Name)" -ForegroundColor Green
        } else {
            Write-Host "Building provisional schema for $($replayFile.Name)" -ForegroundColor Cyan
            node $schemaScript --artifact-dir $artifactDir --fixture-dir $fixtureDir
            if ($LASTEXITCODE -ne 0) {
                throw "Provisional schema generation failed for $($replayFile.FullName)"
            }
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
    if (Test-OutputsFresh -OutputPaths @($corpusSchemaPath) -InputPaths (Get-CorpusSchemaInputs -Entries $processed -SchemaScriptPath $corpusSchemaScript)) {
        Write-Host "Reusing cross-replay corpus schema" -ForegroundColor Green
    } else {
        Write-Host "Building cross-replay corpus schema" -ForegroundColor Cyan
        node $corpusSchemaScript --artifact-root $resolvedArtifactRoot --corpus-manifest $manifestPath --output-path $corpusSchemaPath
        if ($LASTEXITCODE -ne 0) {
            throw "Corpus schema generation failed."
        }
    }
    $manifest.corpusSchemaPath = $corpusSchemaPath
}

if (-not $SkipExtraction) {
    if ($SkipCorpusSchema -and -not (Test-Path $corpusSchemaPath)) {
        throw "Replay-only extraction requires corpus schema at $corpusSchemaPath"
    }

    foreach ($entry in $processed) {
        $extractedPath = Join-Path $entry.artifactDir "extracted-stats.json"
        if (Test-OutputsFresh -OutputPaths @($extractedPath) -InputPaths @(
                $extractScript,
                $corpusSchemaPath,
                (Join-Path $entry.artifactDir "run-manifest.json"),
                (Join-Path $entry.artifactDir "provisional-schema.json"),
                (Join-Path $entry.artifactDir "candidate-matches.json"))) {
            Write-Host "Reusing replay-only stats for $($entry.replayName)" -ForegroundColor Green
        } else {
            Write-Host "Extracting replay-only stats for $($entry.replayName)" -ForegroundColor Cyan
            node $extractScript --artifact-dir $entry.artifactDir --schema-path $corpusSchemaPath --output-path $extractedPath
            if ($LASTEXITCODE -ne 0) {
                throw "Replay-only extraction failed for $($entry.replayName)"
            }
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
        if (Test-OutputsFresh -OutputPaths @($validationPath) -InputPaths @(
                $validateScript,
                $extractedPath,
                (Join-Path $entry.fixtureDir "match.json"),
                (Join-Path $entry.fixtureDir "timeline.json"))) {
            Write-Host "Reusing validation report for $($entry.replayName)" -ForegroundColor Green
        } else {
            Write-Host "Validating extracted stats for $($entry.replayName)" -ForegroundColor Cyan
            node $validateScript --extracted-path $extractedPath --fixture-dir $entry.fixtureDir --output-path $validationPath
            if ($LASTEXITCODE -ne 0) {
                throw "Validation failed for $($entry.replayName)"
            }
        }
        $entry["validationReportPath"] = $validationPath
    }
}

if (-not $SkipCorpusSchema -and -not $SkipExtraction -and -not $SkipValidation) {
    if (Test-OutputsFresh -OutputPaths @($corpusSchemaPath) -InputPaths (Get-CorpusSchemaInputs -Entries $processed -SchemaScriptPath $corpusSchemaScript -IncludeValidation)) {
        Write-Host "Reusing refreshed cross-replay corpus schema" -ForegroundColor Green
    } else {
        Write-Host "Rebuilding cross-replay corpus schema from refreshed extraction results" -ForegroundColor Cyan
        node $corpusSchemaScript --artifact-root $resolvedArtifactRoot --corpus-manifest $manifestPath --output-path $corpusSchemaPath
        if ($LASTEXITCODE -ne 0) {
            throw "Refreshed corpus schema generation failed."
        }
    }

    foreach ($entry in $processed) {
        $extractedPath = if ($entry.Contains("extractedStatsPath")) { $entry.extractedStatsPath } else { Join-Path $entry.artifactDir "extracted-stats.json" }
        if (Test-OutputsFresh -OutputPaths @($extractedPath) -InputPaths @(
                $extractScript,
                $corpusSchemaPath,
                (Join-Path $entry.artifactDir "run-manifest.json"),
                (Join-Path $entry.artifactDir "provisional-schema.json"),
                (Join-Path $entry.artifactDir "candidate-matches.json"))) {
            Write-Host "Reusing replay-only stats for $($entry.replayName) with refreshed schema" -ForegroundColor Green
        } else {
            Write-Host "Re-extracting replay-only stats for $($entry.replayName) with refreshed schema" -ForegroundColor Cyan
            node $extractScript --artifact-dir $entry.artifactDir --schema-path $corpusSchemaPath --output-path $extractedPath
            if ($LASTEXITCODE -ne 0) {
                throw "Replay-only re-extraction failed for $($entry.replayName)"
            }
        }
        $entry["extractedStatsPath"] = $extractedPath
    }

    foreach ($entry in $processed) {
        $extractedPath = $entry.extractedStatsPath
        $validationPath = if ($entry.Contains("validationReportPath")) { $entry.validationReportPath } else { Join-Path $entry.artifactDir "validation-report.json" }
        if (Test-OutputsFresh -OutputPaths @($validationPath) -InputPaths @(
                $validateScript,
                $extractedPath,
                (Join-Path $entry.fixtureDir "match.json"),
                (Join-Path $entry.fixtureDir "timeline.json"))) {
            Write-Host "Reusing validation report for $($entry.replayName) with refreshed schema" -ForegroundColor Green
        } else {
            Write-Host "Re-validating extracted stats for $($entry.replayName) with refreshed schema" -ForegroundColor Cyan
            node $validateScript --extracted-path $extractedPath --fixture-dir $entry.fixtureDir --output-path $validationPath
            if ($LASTEXITCODE -ne 0) {
                throw "Refreshed validation failed for $($entry.replayName)"
            }
        }
        $entry["validationReportPath"] = $validationPath
    }

    if (Test-OutputsFresh -OutputPaths @($corpusSchemaPath) -InputPaths (Get-CorpusSchemaInputs -Entries $processed -SchemaScriptPath $corpusSchemaScript -IncludeValidation)) {
        Write-Host "Reusing finalized cross-replay corpus schema" -ForegroundColor Green
    } else {
        Write-Host "Finalizing cross-replay corpus schema after refreshed validation" -ForegroundColor Cyan
        node $corpusSchemaScript --artifact-root $resolvedArtifactRoot --corpus-manifest $manifestPath --output-path $corpusSchemaPath
        if ($LASTEXITCODE -ne 0) {
            throw "Final corpus schema generation failed."
        }
    }
}

if (-not $SkipMovement) {
    $movementCoordinateModelPath = Join-Path $resolvedArtifactRoot "movement-coordinate-model.json"
    foreach ($entry in $processed) {
        $movementCandidatePath = Join-Path $entry.artifactDir "movement-candidate-matches.json"
        $movementSchemaPath = Join-Path $entry.artifactDir "movement-provisional-schema.json"
        $movementExtractedPath = Join-Path $entry.artifactDir "extracted-movement.json"
        $movementValidationPath = Join-Path $entry.artifactDir "movement-validation-report.json"

        if (Test-OutputsFresh -OutputPaths @($movementCandidatePath, $movementSchemaPath) -InputPaths @(
                $discoverMovementScript,
                (Join-Path $entry.artifactDir "run-manifest.json"),
                (Join-Path $entry.fixtureDir "match.json"),
                (Join-Path $entry.fixtureDir "timeline.json"),
                $movementCoordinateModelPath)) {
            Write-Host "Reusing movement candidates for $($entry.replayName)" -ForegroundColor Green
        } else {
            Write-Host "Discovering movement candidates for $($entry.replayName)" -ForegroundColor Cyan
            if (Test-Path $movementCoordinateModelPath) {
                node $discoverMovementScript --artifact-dir $entry.artifactDir --fixture-dir $entry.fixtureDir --coordinate-model-path $movementCoordinateModelPath
            } else {
                node $discoverMovementScript --artifact-dir $entry.artifactDir --fixture-dir $entry.fixtureDir
            }
            if ($LASTEXITCODE -ne 0) {
                throw "Movement discovery failed for $($entry.replayName)"
            }
        }

        if (Test-OutputsFresh -OutputPaths @($movementExtractedPath) -InputPaths @(
                $extractMovementScript,
                $movementSchemaPath,
                (Join-Path $entry.artifactDir "run-manifest.json"))) {
            Write-Host "Reusing movement tracks for $($entry.replayName)" -ForegroundColor Green
        } else {
            Write-Host "Extracting movement tracks for $($entry.replayName)" -ForegroundColor Cyan
            node $extractMovementScript --artifact-dir $entry.artifactDir --schema-path $movementSchemaPath --output-path $movementExtractedPath
            if ($LASTEXITCODE -ne 0) {
                throw "Movement extraction failed for $($entry.replayName)"
            }
        }

        if (Test-OutputsFresh -OutputPaths @($movementValidationPath) -InputPaths @(
                $validateMovementScript,
                $movementCandidatePath,
                $movementSchemaPath,
                (Join-Path $entry.fixtureDir "timeline.json"))) {
            Write-Host "Reusing movement validation for $($entry.replayName)" -ForegroundColor Green
        } else {
            Write-Host "Validating movement candidates for $($entry.replayName)" -ForegroundColor Cyan
            node $validateMovementScript --candidate-matches-path $movementCandidatePath --provisional-schema-path $movementSchemaPath --output-path $movementValidationPath
            if ($LASTEXITCODE -ne 0) {
                throw "Movement validation failed for $($entry.replayName)"
            }
        }

        $entry["movementCandidatePath"] = $movementCandidatePath
        $entry["movementSchemaPath"] = $movementSchemaPath
        $entry["movementExtractedPath"] = $movementExtractedPath
        $entry["movementValidationPath"] = $movementValidationPath
    }

    $movementIdentityPriorsPath = Join-Path $resolvedArtifactRoot "movement-identity-priors.json"
    $movementPriorsInputs = @($movementIdentityPriorsScript)
    foreach ($entry in $processed) {
        $movementPriorsInputs += @(
            $entry.movementCandidatePath,
            $entry.movementSchemaPath,
            $entry.movementExtractedPath,
            $entry.movementValidationPath
        )
    }
    if (Test-OutputsFresh -OutputPaths @($movementIdentityPriorsPath) -InputPaths $movementPriorsInputs) {
        Write-Host "Reusing movement identity priors" -ForegroundColor Green
    } else {
        Write-Host "Building movement identity priors" -ForegroundColor Cyan
        node $movementIdentityPriorsScript --artifact-root $resolvedArtifactRoot --corpus-manifest $manifestPath --output-path $movementIdentityPriorsPath
        if ($LASTEXITCODE -ne 0) {
            throw "Movement identity prior generation failed."
        }
    }
    $manifest["movementIdentityPriorsPath"] = $movementIdentityPriorsPath

    foreach ($entry in $processed) {
        $participantMovementPath = Join-Path $entry.artifactDir "participant-movement.json"
        $assignedMovementValidationPath = Join-Path $entry.artifactDir "assigned-movement-validation-report.json"

        if (Test-OutputsFresh -OutputPaths @($participantMovementPath) -InputPaths @(
                $assignMovementScript,
                $movementIdentityPriorsPath,
                $entry.movementExtractedPath,
                (Join-Path $entry.artifactDir "extracted-stats.json"))) {
            Write-Host "Reusing participant-labelled movement for $($entry.replayName)" -ForegroundColor Green
        } else {
            Write-Host "Assigning movement tracks to participants for $($entry.replayName)" -ForegroundColor Cyan
            node $assignMovementScript --artifact-dir $entry.artifactDir --priors-path $movementIdentityPriorsPath --output-path $participantMovementPath
            if ($LASTEXITCODE -ne 0) {
                throw "Movement participant assignment failed for $($entry.replayName)"
            }
        }

        if (Test-OutputsFresh -OutputPaths @($assignedMovementValidationPath) -InputPaths @(
                $validateAssignedMovementScript,
                $participantMovementPath,
                (Join-Path $entry.fixtureDir "timeline.json"))) {
            Write-Host "Reusing participant-labelled movement validation for $($entry.replayName)" -ForegroundColor Green
        } else {
            Write-Host "Validating participant-labelled movement for $($entry.replayName)" -ForegroundColor Cyan
            node $validateAssignedMovementScript --participant-movement-path $participantMovementPath --fixture-dir $entry.fixtureDir --output-path $assignedMovementValidationPath
            if ($LASTEXITCODE -ne 0) {
                throw "Participant-labelled movement validation failed for $($entry.replayName)"
            }
        }

        $entry["participantMovementPath"] = $participantMovementPath
        $entry["assignedMovementValidationPath"] = $assignedMovementValidationPath
    }

    $movementModelInputs = @($movementCoordinateModelScript)
    foreach ($entry in $processed) {
        $movementModelInputs += @(
            $entry.movementValidationPath,
            $entry.assignedMovementValidationPath
        )
    }
    if (Test-OutputsFresh -OutputPaths @($movementCoordinateModelPath) -InputPaths $movementModelInputs) {
        Write-Host "Reusing movement coordinate model" -ForegroundColor Green
    } else {
        Write-Host "Building movement coordinate model" -ForegroundColor Cyan
        node $movementCoordinateModelScript --artifact-root $resolvedArtifactRoot --corpus-manifest $manifestPath --output-path $movementCoordinateModelPath
        if ($LASTEXITCODE -ne 0) {
            throw "Movement coordinate model generation failed."
        }
    }
    $manifest["movementCoordinateModelPath"] = $movementCoordinateModelPath
}

$manifest.generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
$manifest.processed = $processed
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Path $manifestPath -Encoding utf8

Write-Host "Wrote corpus manifest to $manifestPath" -ForegroundColor Green
