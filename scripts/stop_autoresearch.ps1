[CmdletBinding()]
param(
    [string]$Tag = (Get-Date -Format "yyyy-MM-dd-decoder")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = Split-Path -Parent $scriptDirectory
$runDirectory = Join-Path $repositoryRoot "tmp\autoresearch\$Tag"
$stopFile = Join-Path $runDirectory "STOP"

New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
New-Item -ItemType File -Force -Path $stopFile | Out-Null
Write-Host "[autoresearch] Stop requested for tag $Tag"
