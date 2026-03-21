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
        FilePath = $pwshCommand.Source
        Prefix = @("-NoProfile", "-File", $codexCommand.Source)
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

$prompt = @"
Read program.md and docs/autonomous-decoder-research.md.
Continue the autonomous decoder research loop in this repository.

Use this run tag: $Tag
Use this ledger file: tmp/autoresearch/$Tag/results.tsv

Do exactly one bounded iteration:
1. inspect the latest kept result and current repo state
2. choose one decoder hypothesis
3. implement the change
4. run fast checks on touched files
5. rerun the full decoder corpus
6. summarize with scripts/summarize_decoder_corpus.mjs --json
7. append exactly one row to tmp/autoresearch/$Tag/results.tsv
8. keep or revert based on the scorecard in program.md
9. update docs only if the finding is actually stable and worth recording
10. stop after this single iteration

Do not ask the user to continue. Complete one full iteration and exit.
"@
$prompt | Set-Content -LiteralPath $promptFile -Encoding utf8

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
    $stdoutPath = Join-Path $runDirectory "codex-$stamp.stdout.log"
    $stderrPath = Join-Path $runDirectory "codex-$stamp.stderr.log"
    $messagePath = Join-Path $runDirectory "codex-$stamp.last-message.txt"
    $metaPath = Join-Path $runDirectory "codex-$stamp.meta.json"
    $startedAtUtc = [DateTime]::UtcNow.ToString("o")

    $argumentList = @()
    $argumentList += $launcher.Prefix
    $argumentList += "exec"
    if ($DangerouslyBypassApprovalsAndSandbox) {
        $argumentList += "--dangerously-bypass-approvals-and-sandbox"
    }
    else {
        $argumentList += "--full-auto"
    }
    $argumentList += "--json"
    $argumentList += "-C"
    $argumentList += $repositoryRoot
    $argumentList += "-o"
    $argumentList += $messagePath
    if ($Model) {
        $argumentList += "-m"
        $argumentList += $Model
    }
    $argumentList += $prompt

    Write-Status "Starting iteration $iteration"

    $process = Start-Process `
        -FilePath $launcher.FilePath `
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
