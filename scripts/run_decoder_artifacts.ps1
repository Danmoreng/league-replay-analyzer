[CmdletBinding()]
param (
    [Parameter(Mandatory = $true)]
    [string]$ReplayPath,
    [string]$ArtifactRoot = "artifacts",
    [string]$AnalyzerExe,
    [string]$BuildDir = "build",
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug",
    [int]$MinLength = 4096,
    [int]$MinRecords = 4,
    [int]$TopFamilies = 8,
    [int]$TopEntitySlots = 24,
    [int]$TopScalarSlots = 18,
    [int]$DynamicSlotCount = 8,
    [int]$MixedSlotCount = 2,
    [int]$HandleSlotCount = 0,
    [int]$TopWindows = 16,
    [int]$TopFields = 16,
    [switch]$SkipScalar,
    [switch]$Clean,
    [switch]$Force
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

function Resolve-AnalyzerExecutable {
    param(
        [string]$ExplicitPath,
        [string]$RepoRoot,
        [string]$BuildDir,
        [string]$Configuration
    )

    if ($ExplicitPath) {
        $resolvedPath = Resolve-AbsolutePath -Path $ExplicitPath -BasePath $RepoRoot
        if (-not (Test-Path $resolvedPath)) {
            throw "Analyzer executable not found at $resolvedPath"
        }
        return $resolvedPath
    }

    $searchRoot = Resolve-AbsolutePath -Path $BuildDir -BasePath $RepoRoot
    if (-not (Test-Path $searchRoot)) {
        throw "Build directory not found at $searchRoot. Build rofl_core_cli first or pass -AnalyzerExe."
    }

    $preferred = Get-ChildItem -Path $searchRoot -Recurse -Filter "rofl_core_cli.exe" -File |
        Sort-Object @{
            Expression = {
                if ($_.FullName -match [Regex]::Escape("\$Configuration\")) { 0 } else { 1 }
            }
        }, @{
            Expression = { $_.FullName.Length }
        } |
        Select-Object -First 1

    if (-not $preferred) {
        throw "Could not find rofl_core_cli.exe under $searchRoot. Build rofl_core_cli first or pass -AnalyzerExe."
    }

    return $preferred.FullName
}

function Invoke-DecoderJson {
    param(
        [string]$Executable,
        [string[]]$Arguments
    )

    $output = & $Executable @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        $message = ($output -join [Environment]::NewLine).Trim()
        if (-not $message) {
            $message = "Decoder command failed without output."
        }
        throw $message
    }

    $raw = ($output -join [Environment]::NewLine).Trim()
    if (-not $raw) {
        throw "Decoder command returned empty output."
    }

    return @{
        Raw = $raw
        Json = $raw | ConvertFrom-Json -AsHashtable
    }
}

function Write-Utf8File {
    param(
        [string]$Path,
        [string]$Content
    )

    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    Set-Content -Path $Path -Value $Content -Encoding utf8
}

function Get-FileFingerprint {
    param([string]$Path)

    $item = Get-Item -LiteralPath $Path
    return [ordered]@{
        path = $item.FullName
        length = if ($item.PSIsContainer) { $null } else { [int64]$item.Length }
        lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString("o")
    }
}

function Read-JsonFile {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
}

function ConvertTo-UtcDateTime {
    param([object]$Value)

    if ($Value -is [DateTime]) {
        return $Value.ToUniversalTime()
    }

    return [DateTime]::Parse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}

function Test-RunManifestFresh {
    param(
        [string]$RunManifestPath,
        [string]$ReplayArtifactDir,
        [hashtable]$ExpectedReplay,
        [hashtable]$ExpectedAnalyzer,
        [hashtable]$ExpectedRunnerScript,
        [hashtable]$ExpectedParameters
    )

    $manifest = Read-JsonFile -Path $RunManifestPath
    if ($null -eq $manifest) {
        return $false
    }

    if (-not $manifest.ContainsKey("inputs") -or -not $manifest.ContainsKey("parameters") -or -not $manifest.ContainsKey("families")) {
        return $false
    }

    $actualReplay = $manifest.inputs.replay
    $actualAnalyzer = $manifest.inputs.analyzerExe
    $actualRunnerScript = $manifest.inputs.runnerScript
    if ($null -eq $actualReplay -or $null -eq $actualAnalyzer -or $null -eq $actualRunnerScript) {
        return $false
    }

    foreach ($pair in @(
            @{ expected = $ExpectedReplay; actual = $actualReplay },
            @{ expected = $ExpectedAnalyzer; actual = $actualAnalyzer },
            @{ expected = $ExpectedRunnerScript; actual = $actualRunnerScript })) {
        if ([string]$pair.expected.path -ne [string]$pair.actual.path) {
            return $false
        }

        if ([string]$pair.expected.length -ne [string]$pair.actual.length) {
            return $false
        }

        $expectedTime = ConvertTo-UtcDateTime -Value $pair.expected.lastWriteTimeUtc
        $actualTime = ConvertTo-UtcDateTime -Value $pair.actual.lastWriteTimeUtc
        if ($expectedTime -ne $actualTime) {
            return $false
        }
    }

    foreach ($parameterKey in $ExpectedParameters.Keys) {
        if (-not $manifest.parameters.ContainsKey($parameterKey)) {
            return $false
        }

        if ([string]$ExpectedParameters[$parameterKey] -ne [string]$manifest.parameters[$parameterKey]) {
            return $false
        }
    }

    if ($manifest.parameters.Count -ne $ExpectedParameters.Count) {
        return $false
    }

    foreach ($requiredFile in @("summary.json", "family-scan.json")) {
        if (-not (Test-Path -LiteralPath (Join-Path $ReplayArtifactDir $requiredFile))) {
            return $false
        }
    }

    foreach ($family in @($manifest.families)) {
        $familyDir = Join-Path (Join-Path $ReplayArtifactDir "families") ([string]$family.familyKey)
        if (-not (Test-Path -LiteralPath $familyDir)) {
            return $false
        }

        foreach ($relativeFile in @($family.files.Values)) {
            if ($null -eq $relativeFile) {
                continue
            }

            if (-not (Test-Path -LiteralPath (Join-Path $familyDir $relativeFile))) {
                return $false
            }
        }
    }

    return $true
}

function Get-HeaderSize {
    param([hashtable]$Family)

    if ($Family.ContainsKey("recommendedHeaderSize")) {
        return [int]$Family.recommendedHeaderSize
    }

    if ($Family.ContainsKey("headerSizeCandidates")) {
        $candidates = @($Family.headerSizeCandidates)
        if ($candidates.Count -gt 0) {
            return [int]$candidates[0].headerSize
        }
    }

    return 0
}

function Get-FamilyKey {
    param([hashtable]$Family)

    $headerSize = Get-HeaderSize -Family $Family
    return "{0}-0x{1:X2}-h{2}" -f [int]$Family.length, [int]$Family.firstByte, $headerSize
}

function Get-TopSlotIndices {
    param(
        [object[]]$Slots,
        [int]$Count,
        [switch]$SortBySlotIndex
    )

    if ($Count -le 0 -or -not $Slots) {
        return @()
    }

    $selectedSlots = @($Slots)
    if ($SortBySlotIndex) {
        $selectedSlots = @($selectedSlots | Sort-Object { [int]$_.slotIndex })
    }

    return @(
        $selectedSlots |
            Select-Object -First $Count |
            ForEach-Object { [int]$_.slotIndex }
    )
}

function Select-CandidateSlots {
    param(
        [hashtable]$EntitySlab,
        [int]$DynamicSlotCount,
        [int]$MixedSlotCount,
        [int]$HandleSlotCount
    )

    # Prefer the low-index dynamic band because current decoder work is strongest in
    # these early dynamic rows for the main mixed slabs.
    $dynamicSlots = Get-TopSlotIndices -Slots @($EntitySlab.topDynamicSlots) -Count $DynamicSlotCount -SortBySlotIndex
    $mixedSlots = Get-TopSlotIndices -Slots @($EntitySlab.topMixedSlots) -Count $MixedSlotCount
    $handleSlots = Get-TopSlotIndices -Slots @($EntitySlab.topHandleSlots) -Count $HandleSlotCount

    $selectedSlots = @(
        $dynamicSlots
        $mixedSlots
        $handleSlots
    ) | Sort-Object -Unique

    return @{
        SelectedSlots = @($selectedSlots)
        DynamicSlots = @($dynamicSlots)
        MixedSlots = @($mixedSlots)
        HandleSlots = @($handleSlots)
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedReplayPath = Resolve-AbsolutePath -Path $ReplayPath -BasePath $repoRoot
if (-not (Test-Path $resolvedReplayPath)) {
    throw "Replay file not found at $resolvedReplayPath"
}

$resolvedArtifactRoot = Resolve-AbsolutePath -Path $ArtifactRoot -BasePath $repoRoot
$replayId = [System.IO.Path]::GetFileNameWithoutExtension($resolvedReplayPath)
$replayArtifactDir = Join-Path $resolvedArtifactRoot $replayId

if ($Clean -and (Test-Path $replayArtifactDir)) {
    Write-Host "Cleaning existing artifact directory $replayArtifactDir" -ForegroundColor Yellow
    Remove-Item -Path $replayArtifactDir -Recurse -Force
}

if (-not (Test-Path $replayArtifactDir)) {
    New-Item -ItemType Directory -Path $replayArtifactDir -Force | Out-Null
}

$resolvedAnalyzerExe = Resolve-AnalyzerExecutable -ExplicitPath $AnalyzerExe -RepoRoot $repoRoot -BuildDir $BuildDir -Configuration $Configuration
$runManifestPath = Join-Path $replayArtifactDir "run-manifest.json"
$parameterManifest = [ordered]@{
    configuration = $Configuration
    minLength = $MinLength
    minRecords = $MinRecords
    topFamilies = $TopFamilies
    topEntitySlots = $TopEntitySlots
    topScalarSlots = $TopScalarSlots
    dynamicSlotCount = $DynamicSlotCount
    mixedSlotCount = $MixedSlotCount
    handleSlotCount = $HandleSlotCount
    topWindows = $TopWindows
    topFields = $TopFields
    skipScalar = [bool]$SkipScalar
}
$inputManifest = [ordered]@{
    replay = Get-FileFingerprint -Path $resolvedReplayPath
    analyzerExe = Get-FileFingerprint -Path $resolvedAnalyzerExe
    runnerScript = Get-FileFingerprint -Path $PSCommandPath
}

if (-not $Clean -and -not $Force) {
    if (Test-RunManifestFresh `
            -RunManifestPath $runManifestPath `
            -ReplayArtifactDir $replayArtifactDir `
            -ExpectedReplay $inputManifest.replay `
            -ExpectedAnalyzer $inputManifest.analyzerExe `
            -ExpectedRunnerScript $inputManifest.runnerScript `
            -ExpectedParameters $parameterManifest) {
        Write-Host "Reusing cached decoder artifacts for $replayId" -ForegroundColor Green
        return
    }
}

$usedNativeBatch = $false

try {
    Write-Host "Generating native decoder artifact bundle for $replayId" -ForegroundColor Cyan
    $batchArguments = @(
        "--analyze-artifact-bundle-json",
        $resolvedReplayPath,
        "--min-length", "$MinLength",
        "--min-records", "$MinRecords",
        "--top-families", "$TopFamilies",
        "--top-entity-slots", "$TopEntitySlots",
        "--top-scalar-slots", "$TopScalarSlots",
        "--dynamic-slot-count", "$DynamicSlotCount",
        "--mixed-slot-count", "$MixedSlotCount",
        "--handle-slot-count", "$HandleSlotCount",
        "--top-windows", "$TopWindows",
        "--top-fields", "$TopFields"
    )
    if ($SkipScalar) {
        $batchArguments += "--skip-scalar"
    }

    $batchResult = Invoke-DecoderJson -Executable $resolvedAnalyzerExe -Arguments $batchArguments
    $batchJson = $batchResult.Json
    if (-not $batchJson.ContainsKey("summary") -or -not $batchJson.ContainsKey("familyScan") -or -not $batchJson.ContainsKey("families")) {
        throw "Native artifact bundle output is missing required fields."
    }

    Write-Utf8File -Path (Join-Path $replayArtifactDir "summary.json") -Content (($batchJson.summary | ConvertTo-Json -Depth 100))
    Write-Utf8File -Path (Join-Path $replayArtifactDir "family-scan.json") -Content (($batchJson.familyScan | ConvertTo-Json -Depth 100))

    $familyManifests = @()
    foreach ($family in @($batchJson.families)) {
        $familyKey = [string]$family.familyKey
        $familyDir = Join-Path (Join-Path $replayArtifactDir "families") $familyKey
        New-Item -ItemType Directory -Path $familyDir -Force | Out-Null

        Write-Utf8File -Path (Join-Path $familyDir "entity-slab.json") -Content (($family.entitySlab | ConvertTo-Json -Depth 100))
        if (-not $SkipScalar -and $null -ne $family.scalar) {
            Write-Utf8File -Path (Join-Path $familyDir "scalar.json") -Content (($family.scalar | ConvertTo-Json -Depth 100))
        }
        if ($null -ne $family.schema) {
            Write-Utf8File -Path (Join-Path $familyDir "schema.json") -Content (($family.schema | ConvertTo-Json -Depth 100))
        }
        if ($null -ne $family.cleaned) {
            Write-Utf8File -Path (Join-Path $familyDir "cleaned.json") -Content (($family.cleaned | ConvertTo-Json -Depth 100))
        }

        $selectedSlots = @($family.selectedSlots | ForEach-Object { [int]$_ })
        $familyManifest = [ordered]@{
            familyKey = $familyKey
            length = [int]$family.length
            firstByte = [int]$family.firstByte
            headerSize = [int]$family.headerSize
            stride = [int]$family.stride
            recordCount = [int]$family.recordCount
            chunkCount = [int]$family.chunkCount
            selectedSlots = $selectedSlots
            dynamicSlots = @($family.dynamicSlots | ForEach-Object { [int]$_ })
            mixedSlots = @($family.mixedSlots | ForEach-Object { [int]$_ })
            handleSlots = @($family.handleSlots | ForEach-Object { [int]$_ })
            files = [ordered]@{
                entitySlab = "entity-slab.json"
                scalar = if ($SkipScalar -or $null -eq $family.scalar) { $null } else { "scalar.json" }
                schema = if ($null -eq $family.schema) { $null } else { "schema.json" }
                cleaned = if ($null -eq $family.cleaned) { $null } else { "cleaned.json" }
            }
        }

        Write-Utf8File -Path (Join-Path $familyDir "analysis-plan.json") -Content ($familyManifest | ConvertTo-Json -Depth 8)
        $familyManifests += $familyManifest
    }

    $runManifest = [ordered]@{
        replayId = $replayId
        replayPath = $resolvedReplayPath
        analyzerExe = $resolvedAnalyzerExe
        generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        summary = [ordered]@{
            gameVersion = $batchJson.summary.gameVersion
            gameLengthMillis = $batchJson.summary.gameLengthMillis
            playerCount = $batchJson.summary.playerCount
        }
        inputs = $inputManifest
        parameters = $parameterManifest
        families = $familyManifests
    }

    Write-Utf8File -Path $runManifestPath -Content ($runManifest | ConvertTo-Json -Depth 8)
    Write-Host "Wrote decoder artifacts to $replayArtifactDir using native batch mode" -ForegroundColor Green
    $usedNativeBatch = $true
} catch {
    Write-Host "Native batch artifact analysis unavailable, falling back to legacy per-command mode: $($_.Exception.Message)" -ForegroundColor Yellow
}

if (-not $usedNativeBatch) {
    Write-Host "Scanning replay families for $replayId" -ForegroundColor Cyan
    $summaryResult = Invoke-DecoderJson -Executable $resolvedAnalyzerExe -Arguments @(
        "--summary",
        $resolvedReplayPath
    )
    Write-Utf8File -Path (Join-Path $replayArtifactDir "summary.json") -Content $summaryResult.Raw

    $familyScanResult = Invoke-DecoderJson -Executable $resolvedAnalyzerExe -Arguments @(
        "--scan-families-json",
        $resolvedReplayPath,
        "--min-length", "$MinLength",
        "--min-records", "$MinRecords",
        "--top-families", "$TopFamilies"
    )

    Write-Utf8File -Path (Join-Path $replayArtifactDir "family-scan.json") -Content $familyScanResult.Raw

    $familyList = @($familyScanResult.Json.families)
    if ($familyList.Count -eq 0) {
        throw "Family scan returned no families."
    }

    $familyManifests = @()

    foreach ($family in $familyList) {
        $length = [int]$family.length
        $firstByte = [int]$family.firstByte
        $headerSize = Get-HeaderSize -Family $family
        $stride = if ($family.ContainsKey("recommendedStride")) { [int]$family.recommendedStride } else { 16 }
        $familyKey = Get-FamilyKey -Family $family
        $familyDir = Join-Path (Join-Path $replayArtifactDir "families") $familyKey
        New-Item -ItemType Directory -Path $familyDir -Force | Out-Null

        Write-Host "Analyzing family $familyKey" -ForegroundColor Cyan

        $entityResult = Invoke-DecoderJson -Executable $resolvedAnalyzerExe -Arguments @(
            "--analyze-entity-slab-json",
            $resolvedReplayPath,
            "--length", "$length",
            "--first-byte", ("0x{0:X2}" -f $firstByte),
            "--header-size", "$headerSize",
            "--stride", "$stride",
            "--top-slots", "$TopEntitySlots"
        )
        Write-Utf8File -Path (Join-Path $familyDir "entity-slab.json") -Content $entityResult.Raw

        if (-not $SkipScalar) {
            $scalarResult = Invoke-DecoderJson -Executable $resolvedAnalyzerExe -Arguments @(
                "--analyze-scalar-family-json",
                $resolvedReplayPath,
                "--length", "$length",
                "--first-byte", ("0x{0:X2}" -f $firstByte),
                "--header-size", "$headerSize",
                "--stride", "$stride",
                "--top-slots", "$TopScalarSlots"
            )
            Write-Utf8File -Path (Join-Path $familyDir "scalar.json") -Content $scalarResult.Raw
        }

        $slotSelection = Select-CandidateSlots -EntitySlab $entityResult.Json -DynamicSlotCount $DynamicSlotCount -MixedSlotCount $MixedSlotCount -HandleSlotCount $HandleSlotCount
        $selectedSlots = @($slotSelection.SelectedSlots)

        $familyManifest = [ordered]@{
            familyKey = $familyKey
            length = $length
            firstByte = $firstByte
            headerSize = $headerSize
            stride = $stride
            recordCount = if ($family.ContainsKey("recordCount")) { [int]$family.recordCount } else { $null }
            chunkCount = if ($family.ContainsKey("chunkCount")) { [int]$family.chunkCount } else { $null }
            selectedSlots = $selectedSlots
            dynamicSlots = @($slotSelection.DynamicSlots)
            mixedSlots = @($slotSelection.MixedSlots)
            handleSlots = @($slotSelection.HandleSlots)
            files = [ordered]@{
                entitySlab = "entity-slab.json"
                scalar = if ($SkipScalar) { $null } else { "scalar.json" }
                schema = if ($selectedSlots.Count -gt 0) { "schema.json" } else { $null }
                cleaned = if ($selectedSlots.Count -gt 0) { "cleaned.json" } else { $null }
            }
        }

        if ($selectedSlots.Count -gt 0) {
            $slotList = ($selectedSlots -join ",")

            $schemaResult = Invoke-DecoderJson -Executable $resolvedAnalyzerExe -Arguments @(
                "--analyze-bitfield-schema-json",
                $resolvedReplayPath,
                "--length", "$length",
                "--first-byte", ("0x{0:X2}" -f $firstByte),
                "--header-size", "$headerSize",
                "--stride", "$stride",
                "--slots", $slotList,
                "--top-windows", "$TopWindows"
            )
            Write-Utf8File -Path (Join-Path $familyDir "schema.json") -Content $schemaResult.Raw

            $cleanResult = Invoke-DecoderJson -Executable $resolvedAnalyzerExe -Arguments @(
                "--analyze-clean-row-offsets-json",
                $resolvedReplayPath,
                "--length", "$length",
                "--first-byte", ("0x{0:X2}" -f $firstByte),
                "--header-size", "$headerSize",
                "--stride", "$stride",
                "--slots", $slotList,
                "--top-fields", "$TopFields"
            )
            Write-Utf8File -Path (Join-Path $familyDir "cleaned.json") -Content $cleanResult.Raw
        } else {
            Write-Host "Skipping schema/cleaned analysis for $familyKey because no candidate slots were selected." -ForegroundColor Yellow
        }

        $familyManifestPath = Join-Path $familyDir "analysis-plan.json"
        Write-Utf8File -Path $familyManifestPath -Content ($familyManifest | ConvertTo-Json -Depth 8)
        $familyManifests += $familyManifest
    }

    $runManifest = [ordered]@{
        replayId = $replayId
        replayPath = $resolvedReplayPath
        analyzerExe = $resolvedAnalyzerExe
        generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        summary = [ordered]@{
            gameVersion = $summaryResult.Json.gameVersion
            gameLengthMillis = $summaryResult.Json.gameLengthMillis
            playerCount = $summaryResult.Json.playerCount
        }
        inputs = $inputManifest
        parameters = $parameterManifest
        families = $familyManifests
    }

    Write-Utf8File -Path $runManifestPath -Content ($runManifest | ConvertTo-Json -Depth 8)

    Write-Host "Wrote decoder artifacts to $replayArtifactDir" -ForegroundColor Green
}
