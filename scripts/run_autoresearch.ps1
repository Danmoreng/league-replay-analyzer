[CmdletBinding()]
param(
    [string]$Tag = (Get-Date -Format "yyyy-MM-dd-decoder"),
    [int]$MaxIterations = 0,
    [int]$SleepSeconds = 5,
    [int]$IterationTimeoutMinutes = 180,
    [string]$Model,
    [switch]$EnsureResearchBranch,
    [switch]$DangerouslyBypassApprovalsAndSandbox
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Tag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
    throw "Tag must contain only letters, digits, dots, underscores, and hyphens, and must start with a letter or digit."
}

function Write-Status {
    param([string]$Message)
    Write-Host "[autoresearch] $Message"
}

function Ensure-ResultsFile {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        "commit`tscalar_passes`tmovement_passes`tpromoted_patterns`tpromoted_bundle_patterns`tstatus`tdescription" |
            Set-Content -LiteralPath $Path -Encoding utf8
    }
}

function Get-CodexLauncher {
    $codexCommand = Get-Command codex -ErrorAction Stop
    $pwshCommand = Get-Command pwsh -ErrorAction Stop
    return @{
        PowerShellPath = $pwshCommand.Source
        CodexPath = $codexCommand.Source
    }
}

function Ensure-ResearchBranch {
    param(
        [string]$RepositoryRoot,
        [string]$BranchName
    )

    $currentBranchOutput = git -C $RepositoryRoot branch --show-current
    $currentBranch = if ($null -eq $currentBranchOutput) { "" } else { ([string]$currentBranchOutput).Trim() }
    if ($currentBranch -eq $BranchName) {
        return
    }

    $existingOutput = git -C $RepositoryRoot branch --list $BranchName
    $existing = if ($null -eq $existingOutput) { "" } else { ([string]$existingOutput).Trim() }
    if ($existing) {
        Write-Status "Checking out existing branch $BranchName"
        git -C $RepositoryRoot checkout $BranchName | Out-Host
        return
    }

    Write-Status "Creating branch $BranchName"
    git -C $RepositoryRoot checkout -b $BranchName | Out-Host
}

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = Split-Path -Parent $scriptDirectory
$runDirectory = Join-Path $repositoryRoot "tmp\autoresearch\$Tag"
$stopFile = Join-Path $runDirectory "STOP"
$resultsFile = Join-Path $runDirectory "results.tsv"
$promptFile = Join-Path $runDirectory "loop-prompt.txt"
$branchName = "autoresearch/$Tag"

New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
Ensure-ResultsFile -Path $resultsFile

if ($EnsureResearchBranch) {
    Ensure-ResearchBranch -RepositoryRoot $repositoryRoot -BranchName $branchName
}

$launcher = Get-CodexLauncher
$iteration = 0

while ($true) {
    if (Test-Path -LiteralPath $stopFile) {
        Write-Status "Stop file detected. Exiting."
        break
    }

    if ($MaxIterations -gt 0 -and $iteration -ge $MaxIterations) {
        Write-Status "Reached max iterations: $MaxIterations"
        break
    }

    $iteration += 1
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $iterationArtifactRootRelative = "tmp/autoresearch/$Tag/scores/iteration-$iteration-$stamp"
    $iterationArtifactRoot = Join-Path $repositoryRoot $iterationArtifactRootRelative
    if (Test-Path -LiteralPath $iterationArtifactRoot) {
        throw "Autoresearch score root already exists: $iterationArtifactRoot"
    }

    $prompt = @"
Read program.md and docs/autonomous-decoder-research.md.
Continue the autonomous decoder research loop in this repository.

Use this run tag: $Tag
Use this ledger file: tmp/autoresearch/$Tag/results.tsv
Use this fresh ScoreOnly corpus root for this iteration only: $iterationArtifactRootRelative

Do exactly one bounded iteration:
1. inspect the latest kept result and current repo state
2. choose one decoder hypothesis
3. implement the change
4. run fast checks on touched files
5. rerun the complete 57-replay decoder corpus in ScoreOnly mode exactly with:
   pwsh -File .\scripts\run_decoder_corpus.ps1 -Configuration Debug -ScoreOnly -ArtifactRoot '$iterationArtifactRootRelative' -RequireEmptyArtifactRoot -Force -CleanReplayArtifacts
6. summarize exactly that ScoreOnly root with:
   node .\scripts\summarize_decoder_corpus.mjs --artifact-root '$iterationArtifactRootRelative' --json
7. append exactly one row to tmp/autoresearch/$Tag/results.tsv and include the score-root path in its description
8. keep or revert based on the scorecard in program.md
9. update docs only if the finding is actually stable and worth recording
10. stop after this single iteration

Do not use the shared artifacts root. Full debug artifacts are permitted only for an explicit research question, never as the default keep/revert gate. Do not ask the user to continue. Complete one full iteration and exit.
"@
    $prompt | Set-Content -LiteralPath $promptFile -Encoding utf8

    $stdoutPath = Join-Path $runDirectory "codex-$stamp.stdout.log"
    $stderrPath = Join-Path $runDirectory "codex-$stamp.stderr.log"
    $messagePath = Join-Path $runDirectory "codex-$stamp.last-message.txt"
    $metaPath = Join-Path $runDirectory "codex-$stamp.meta.json"
    $startedAtUtc = [DateTime]::UtcNow.ToString("o")

    $argumentList = @()
    $promptFileLiteral = $promptFile.Replace("'", "''")
    $codexPathLiteral = $launcher.CodexPath.Replace("'", "''")
    $repositoryRootLiteral = $repositoryRoot.Replace("'", "''")
    $messagePathLiteral = $messagePath.Replace("'", "''")
    $modelClause = if ($Model) {
        "-m '$($Model.Replace("'", "''"))'"
    }
    else {
        ""
    }
    $modeClause = if ($DangerouslyBypassApprovalsAndSandbox) {
        "--dangerously-bypass-approvals-and-sandbox"
    }
    else {
        "--full-auto"
    }
    $command = @"
`$promptText = Get-Content -Raw -LiteralPath '$promptFileLiteral'
`$promptText | & '$codexPathLiteral' exec $modeClause --json -C '$repositoryRootLiteral' -o '$messagePathLiteral' $modelClause -
"@
    $argumentList += "-NoProfile"
    $argumentList += "-Command"
    $argumentList += $command

    Write-Status "Starting iteration $iteration"

    $process = Start-Process `
        -FilePath $launcher.PowerShellPath `
        -ArgumentList $argumentList `
        -WorkingDirectory $repositoryRoot `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru `
        -WindowStyle Hidden

    $completed = $process.WaitForExit($IterationTimeoutMinutes * 60 * 1000)
    if (-not $completed) {
        Write-Status "Iteration $iteration exceeded timeout of $IterationTimeoutMinutes minutes. Stopping process."
        Stop-Process -Id $process.Id -Force
        Add-Content -LiteralPath $stderrPath -Value "Supervisor timeout after $IterationTimeoutMinutes minutes."
    }

    $exitCode = if ($completed) { $process.ExitCode } else { -1 }
    Write-Status "Iteration $iteration exited with code $exitCode"

    @{
        iteration = $iteration
        tag = $Tag
        startedAtUtc = $startedAtUtc
        finishedAtUtc = [DateTime]::UtcNow.ToString("o")
        exitCode = $exitCode
        completed = $completed
        artifactRoot = $iterationArtifactRoot
        artifactRootRelative = $iterationArtifactRootRelative
        stdoutPath = $stdoutPath
        stderrPath = $stderrPath
        messagePath = $messagePath
    } | ConvertTo-Json | Set-Content -LiteralPath $metaPath -Encoding utf8

    if (Test-Path -LiteralPath $stopFile) {
        Write-Status "Stop file detected after iteration $iteration. Exiting."
        break
    }

    if ($SleepSeconds -gt 0) {
        Start-Sleep -Seconds $SleepSeconds
    }
}
